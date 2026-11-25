const SUPABASE_URL = process.env.SUPABASE_URL;
const EXPECTED_AMOUNT = 2000;
const HISTORICAL_AMOUNT = 1300;

function sendJson(response,statusCode,payload){response.status(statusCode).json(payload)}
function normalize(value){return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''}
function getBearerToken(request){const value=request.headers.authorization||request.headers.Authorization||'';return value.startsWith('Bearer ')?value.slice(7).trim():''}
async function readJson(response){try{return await response.json()}catch{return null}}
async function supabaseRequest(path,{method='GET',body=null,token=null,prefer=null}={}){
  const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!SUPABASE_URL)throw new Error('Missing SUPABASE_URL');
  if(!key)throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  const headers={apikey:key,Authorization:'Bearer '+(token||key),'Content-Type':'application/json'};
  if(prefer)headers.Prefer=prefer;
  const res=await fetch(SUPABASE_URL+path,{method,headers,body:body?JSON.stringify(body):null});
  const data=await readJson(res);
  if(!res.ok){const error=new Error(data&&data.message?data.message:'Supabase request failed');error.statusCode=res.status;error.details=data;throw error}
  return data;
}
async function getUserFromRequest(request){const token=getBearerToken(request);if(!token)return null;try{return await supabaseRequest('/auth/v1/user',{token})}catch{return null}}
async function requireAdmin(request,response){
  const user=await getUserFromRequest(request);
  if(!user){sendJson(response,401,{success:false,message:'Please log in first'});return null}
  const rows=await supabaseRequest('/rest/v1/admin_users?select=id,user_id,email&user_id=eq.'+encodeURIComponent(user.id)+'&limit=1');
  if(!Array.isArray(rows)||!rows.length){sendJson(response,403,{success:false,message:'Admin access required'});return null}
  return user;
}
async function listAuthUsers(){
  const all=[];
  for(let page=1;page<=20;page++){
    const data=await supabaseRequest('/auth/v1/admin/users?page='+page+'&per_page=1000');
    const users=Array.isArray(data&&data.users)?data.users:Array.isArray(data)?data:[];
    all.push(...users);
    if(users.length<1000)break;
  }
  return all;
}
async function findAuthUserByEmail(email){
  const needle=normalize(email).toLowerCase();
  if(!needle)return null;
  const users=await listAuthUsers();
  return users.find(user=>String(user.email||'').toLowerCase()===needle)||null;
}
async function findActiveSubscriptionByReference(reference){
  return await supabaseRequest('/rest/v1/user_subscriptions?select=*&payment_reference=eq.'+encodeURIComponent(reference)+'&status=eq.active&limit=1');
}
async function retireDuplicateSubscription(row,reference,adminEmail){
  if(!row||!row.id)return;
  await supabaseRequest('/rest/v1/user_subscriptions?id=eq.'+encodeURIComponent(row.id),{method:'PATCH',body:{status:'inactive',verified:false,payment_reference:'reassigned:'+reference+':'+new Date().toISOString(),updated_at:new Date().toISOString()},prefer:'return=minimal'});
}
function trustedCutoverDate(){
  const raw=normalize(process.env.TSC_PRICE_CUTOVER_AT||process.env.SUBSCRIPTION_PRICE_CUTOVER_AT);
  if(!raw)return null;
  const date=new Date(raw);
  return Number.isNaN(date.getTime())?null:date;
}
function isBeforeCutover(value){
  const cutover=trustedCutoverDate();
  if(!cutover)return false;
  const date=new Date(value);
  return !Number.isNaN(date.getTime())&&date.getTime()<cutover.getTime();
}
function validateAttachableAmount(record){
  const amount=Number(record&&record.amount);
  if(amount===EXPECTED_AMOUNT)return {ok:true,amount:EXPECTED_AMOUNT,historical:false};
  if(amount===HISTORICAL_AMOUNT){
    if(isBeforeCutover(record.created_at))return {ok:true,amount:HISTORICAL_AMOUNT,historical:true};
    const error=new Error('Historical ₦1,300 payment requires explicit administrator review with trusted pre-cutover evidence before activation.');
    error.statusCode=409;
    error.requiresHistoricalReview=true;
    throw error;
  }
  const error=new Error('Amount must be ₦2,000 for new payments, or ₦1,300 only for trusted pre-cutover historical payments.');
  error.statusCode=400;
  throw error;
}
async function upsertSubscription({user,email,reference,amount=EXPECTED_AMOUNT,adminEmail}){
  const now=new Date().toISOString();
  const existing=await supabaseRequest('/rest/v1/user_subscriptions?select=id&user_id=eq.'+encodeURIComponent(user.id)+'&limit=1');
  const payload={user_id:user.id,email,status:'active',verified:true,payment_method:'bank_transfer',amount,currency:'NGN',payment_reference:reference,paid_at:now,updated_at:now};
  if(Array.isArray(existing)&&existing.length){
    await supabaseRequest('/rest/v1/user_subscriptions?id=eq.'+encodeURIComponent(existing[0].id),{method:'PATCH',body:payload,prefer:'return=minimal'});
    return existing[0].id;
  }
  const inserted=await supabaseRequest('/rest/v1/user_subscriptions',{method:'POST',body:payload,prefer:'return=representation'});
  return Array.isArray(inserted)&&inserted[0]?inserted[0].id:null;
}
async function writeApprovedManualAudit({user,email,payerName,bankName,phone,reference,note,amount=EXPECTED_AMOUNT,adminEmail}){
  const now=new Date().toISOString();
  await supabaseRequest('/rest/v1/manual_payment_requests',{method:'POST',body:{user_id:user.id,email,payer_name:payerName,bank_name:bankName||null,phone:phone||null,payment_reference:reference,receipt_url:null,amount,status:'approved',reviewed_at:now,reviewed_by:adminEmail,note:note||null},prefer:'return=minimal'});
}
async function ensureReferenceAvailable(reference,targetUserId,confirmReassign,adminEmail){
  const duplicates=await findActiveSubscriptionByReference(reference);
  const duplicate=Array.isArray(duplicates)?duplicates.find(row=>row.user_id!==targetUserId):null;
  if(duplicate&&!confirmReassign){
    const error=new Error('This payment reference already exists for another active subscription.');
    error.statusCode=409;
    error.requiresConfirmation=true;
    throw error;
  }
  if(duplicate&&confirmReassign)await retireDuplicateSubscription(duplicate,reference,adminEmail);
}
async function getSummary(){
  const users=await listAuthUsers();
  const subscriptions=await supabaseRequest('/rest/v1/user_subscriptions?select=status,verified,amount,payment_method');
  const manual=await supabaseRequest('/rest/v1/manual_payment_requests?select=status');
  const external=await supabaseRequest('/rest/v1/external_payment_records?select=status');
  const active=(subscriptions||[]).filter(row=>row.status==='active'&&row.verified===true);
  return {
    totalSignups:users.length,
    verifiedUsers:users.filter(user=>user.email_confirmed_at||user.confirmed_at).length,
    unverifiedUsers:users.filter(user=>!(user.email_confirmed_at||user.confirmed_at)).length,
    activeSubscribers:active.length,
    flutterwavePayments:active.filter(row=>row.payment_method!=='bank_transfer').length,
    bankTransferPayments:active.filter(row=>row.payment_method==='bank_transfer').length,
    pendingManualPayments:(manual||[]).filter(row=>row.status==='pending').length,
    pendingExternalPayments:(external||[]).filter(row=>row.status==='waiting_for_account').length,
    estimatedRevenue:active.reduce((total,row)=>total+(Number(row.amount)||0),0)
  };
}
async function listExternalPayments(){
  return await supabaseRequest('/rest/v1/external_payment_records?select=*&status=eq.waiting_for_account&order=created_at.desc&limit=100');
}
async function manualActivate(input,admin){
  const email=normalize(input.email).toLowerCase();
  const payerName=normalize(input.payer_name||input.payerName);
  const bankName=normalize(input.bank_name||input.bankName);
  const reference=normalize(input.payment_reference||input.reference);
  const phone=normalize(input.phone);
  const note=normalize(input.note);
  const amount=Number(input.amount);
  if(!email||!payerName||!reference||amount!==EXPECTED_AMOUNT)return {statusCode:400,payload:{success:false,message:'User email, payer name, payment reference, and exact ₦2,000 amount are required'}};
  const targetUser=await findAuthUserByEmail(email);
  if(!targetUser)return {statusCode:404,payload:{success:false,message:'No account exists for this email. Ask the user to create an account first.'}};
  await ensureReferenceAvailable(reference,targetUser.id,input.confirmReassign===true,admin.email||'');
  const subscriptionId=await upsertSubscription({user:targetUser,email,reference,adminEmail:admin.email||''});
  await writeApprovedManualAudit({user:targetUser,email,payerName,bankName,phone,reference,note,adminEmail:admin.email||''});
  return {statusCode:200,payload:{success:true,message:'Subscription activated.',subscriptionId}};
}
async function recordExternal(input,admin){
  const payerName=normalize(input.payer_name||input.payerName);
  const bankName=normalize(input.bank_name||input.bankName);
  const reference=normalize(input.payment_reference||input.reference);
  const phone=normalize(input.phone);
  const note=normalize(input.note);
  const amount=Number(input.amount);
  if(!payerName||!reference||!amount)return {statusCode:400,payload:{success:false,message:'Payer name, amount, and reference are required'}};
  await supabaseRequest('/rest/v1/external_payment_records',{method:'POST',body:{payer_name:payerName,bank_name:bankName||null,amount,payment_reference:reference,phone:phone||null,note:note||null,status:'waiting_for_account',reviewed_by:admin.email||null},prefer:'return=minimal'});
  return {statusCode:200,payload:{success:true,message:'External payment recorded.'}};
}
async function attachExternal(input,admin){
  const id=normalize(input.id);
  const email=normalize(input.email).toLowerCase();
  if(!id||!email)return {statusCode:400,payload:{success:false,message:'External payment id and user email are required'}};
  const rows=await supabaseRequest('/rest/v1/external_payment_records?select=*&id=eq.'+encodeURIComponent(id)+'&limit=1');
  const record=Array.isArray(rows)&&rows.length?rows[0]:null;
  if(!record)return {statusCode:404,payload:{success:false,message:'External payment not found'}};
  let amountCheck;
  try{
    amountCheck=validateAttachableAmount(record);
  }catch(error){
    return {statusCode:error.statusCode||400,payload:{success:false,requiresHistoricalReview:error.requiresHistoricalReview===true,message:error.message}};
  }
  const targetUser=await findAuthUserByEmail(email);
  if(!targetUser)return {statusCode:404,payload:{success:false,message:'No account exists for this email. Ask the user to create an account first.'}};
  await ensureReferenceAvailable(record.payment_reference,targetUser.id,input.confirmReassign===true,admin.email||'');
  const subscriptionId=await upsertSubscription({user:targetUser,email,reference:record.payment_reference,amount:amountCheck.amount,adminEmail:admin.email||''});
  const historicalNote=amountCheck.historical?'Historical pre-cutover ₦1,300 payment attached using trusted external payment record created before configured price cutover. ':'';
  await writeApprovedManualAudit({user:targetUser,email,payerName:record.payer_name,bankName:record.bank_name,phone:record.phone,reference:record.payment_reference,note:historicalNote+(record.note||''),amount:amountCheck.amount,adminEmail:admin.email||''});
  await supabaseRequest('/rest/v1/external_payment_records?id=eq.'+encodeURIComponent(id),{method:'PATCH',body:{status:'attached',user_id:targetUser.id,email,attached_at:new Date().toISOString(),reviewed_by:admin.email||null},prefer:'return=minimal'});
  return {statusCode:200,payload:{success:true,message:'External payment attached and subscription activated.',subscriptionId}};
}

module.exports=async function handler(request,response){
  try{
    const admin=await requireAdmin(request,response);
    if(!admin)return;
    if(request.method==='GET'){
      return sendJson(response,200,{success:true,summary:await getSummary(),externalPayments:await listExternalPayments()});
    }
    if(request.method==='POST'){
      const input=request.body||{};
      const action=normalize(input.action);
      const result=action==='manualActivate'?await manualActivate(input,admin):action==='recordExternal'?await recordExternal(input,admin):action==='attachExternal'?await attachExternal(input,admin):{statusCode:400,payload:{success:false,message:'Invalid admin bank payment action'}};
      return sendJson(response,result.statusCode,result.payload);
    }
    response.setHeader('Allow','GET, POST');
    return sendJson(response,405,{success:false,message:'Method not allowed'});
  }catch(error){
    if(error.requiresConfirmation)return sendJson(response,error.statusCode||409,{success:false,requiresConfirmation:true,message:error.message});
    console.error('Admin bank payment error:',error);
    return sendJson(response,error.statusCode||500,{success:false,message:error.statusCode&&error.statusCode<500?error.message:'Admin bank payment request failed'});
  }
}
