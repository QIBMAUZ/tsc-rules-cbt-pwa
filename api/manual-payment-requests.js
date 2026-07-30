const SUPABASE_URL = process.env.SUPABASE_URL;
const EXPECTED_AMOUNT = 1300;
const BUCKET = 'manual-payment-receipts';

function sendJson(response, statusCode, payload){response.status(statusCode).json(payload)}
function normalize(value){return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''}
function getBearerToken(request){const value=request.headers.authorization||request.headers.Authorization||'';return value.startsWith('Bearer ')?value.slice(7).trim():''}
async function readJson(response){try{return await response.json()}catch{return null}}
async function supabaseRequest(path,{method='GET',body=null,token=null,prefer=null,contentType='application/json'}={}){
  const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!SUPABASE_URL)throw new Error('Missing SUPABASE_URL');
  if(!key)throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  const headers={apikey:key,Authorization:'Bearer '+(token||key)};
  if(contentType)headers['Content-Type']=contentType;
  if(prefer)headers.Prefer=prefer;
  const res=await fetch(SUPABASE_URL+path,{method,headers,body:contentType==='application/json'&&body?JSON.stringify(body):body});
  const data=await readJson(res);
  if(!res.ok){const message=data&&data.message?data.message:'Supabase request failed';const error=new Error(message);error.statusCode=res.status;error.details=data;throw error}
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
async function countAuthUsers(){
  let total=0;
  for(let page=1;page<=20;page++){
    const data=await supabaseRequest('/auth/v1/admin/users?page='+page+'&per_page=1000');
    const users=Array.isArray(data&&data.users)?data.users:Array.isArray(data)?data:[];
    total+=users.length;
    if(users.length<1000)break;
  }
  return total;
}
async function createSignedReceiptUrl(storedPath){
  const value=normalize(storedPath);
  if(!value)return '';
  let objectPath=value;
  const marker='/storage/v1/object/public/'+BUCKET+'/';
  const markerIndex=value.indexOf(marker);
  if(markerIndex>=0)objectPath=value.slice(markerIndex+marker.length);
  if(/^https?:\/\//i.test(objectPath))return '';
  const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res=await fetch(SUPABASE_URL+'/storage/v1/object/sign/'+BUCKET+'/'+objectPath,{
    method:'POST',
    headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},
    body:JSON.stringify({expiresIn:300})
  });
  const data=await readJson(res);
  if(!res.ok||!data||!data.signedURL)return '';
  return SUPABASE_URL+'/storage/v1'+data.signedURL;
}
async function addSignedReceiptLinks(rows){
  return Promise.all((rows||[]).map(async row=>{
    const copy={...row};
    copy.receipt_url=await createSignedReceiptUrl(row.receipt_url);
    return copy;
  }));
}
async function findActiveSubscriptionByReference(reference){
  return await supabaseRequest('/rest/v1/user_subscriptions?select=*&payment_reference=eq.'+encodeURIComponent(reference)+'&status=eq.active&limit=1');
}
async function retireDuplicateSubscription(row,reference){
  if(!row||!row.id)return;
  await supabaseRequest('/rest/v1/user_subscriptions?id=eq.'+encodeURIComponent(row.id),{method:'PATCH',body:{status:'inactive',verified:false,payment_reference:'reassigned:'+reference+':'+new Date().toISOString(),updated_at:new Date().toISOString()},prefer:'return=minimal'});
}
async function ensureReferenceAvailable(reference,targetUserId,confirmReassign){
  const duplicates=await findActiveSubscriptionByReference(reference);
  const duplicate=Array.isArray(duplicates)?duplicates.find(item=>item.user_id!==targetUserId):null;
  if(duplicate&&!confirmReassign){const error=new Error('This payment reference already exists for another active subscription.');error.statusCode=409;error.requiresConfirmation=true;throw error}
  if(duplicate&&confirmReassign)await retireDuplicateSubscription(duplicate,reference);
}
async function getAdminSummary(){
  const subscriptions=await supabaseRequest('/rest/v1/user_subscriptions?select=status,verified,amount,payment_method');
  const manual=await supabaseRequest('/rest/v1/manual_payment_requests?select=status,amount');
  const active=(subscriptions||[]).filter(row=>row.status==='active'&&row.verified===true);
  const sumAmount=rows=>rows.reduce((total,row)=>total+(Number(row.amount)||0),0);
  return {
    totalRegisteredUsers:await countAuthUsers(),
    activeSubscribers:active.length,
    pendingManualPayments:(manual||[]).filter(row=>row.status==='pending').length,
    approvedManualPayments:(manual||[]).filter(row=>row.status==='approved').length,
    rejectedManualPayments:(manual||[]).filter(row=>row.status==='rejected').length,
    estimatedRevenue:sumAmount(active),
    flutterwaveSubscriptions:active.filter(row=>row.payment_method!=='bank_transfer').length,
    bankTransferSubscriptions:active.filter(row=>row.payment_method==='bank_transfer').length
  };
}
function parseDataUrl(dataUrl){
  const value=normalize(dataUrl);
  if(!value)return null;
  const match=value.match(/^data:([^;,]+);base64,(.+)$/);
  if(!match)return null;
  return {contentType:match[1],buffer:Buffer.from(match[2],'base64')};
}
function safeReceiptName(name){
  const cleaned=normalize(name).replace(/[^a-z0-9._-]/gi,'-').slice(0,80);
  return cleaned || 'receipt-upload';
}
async function uploadReceipt(userId,file){
  if(!file||!file.dataUrl)return null;
  const parsed=parseDataUrl(file.dataUrl);
  if(!parsed)return null;
  if(parsed.buffer.length>3*1024*1024){const error=new Error('Receipt file is too large. Please upload a file below 3MB.');error.statusCode=400;throw error}
  const path=encodeURIComponent(userId)+'/'+Date.now()+'-'+encodeURIComponent(safeReceiptName(file.name));
  const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res=await fetch(SUPABASE_URL+'/storage/v1/object/'+BUCKET+'/'+path,{
    method:'POST',
    headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':parsed.contentType,'x-upsert':'true'},
    body:parsed.buffer
  });
  if(!res.ok){const data=await readJson(res);const error=new Error(data&&data.message?data.message:'Receipt upload failed');error.statusCode=res.status;throw error}
  return path;
}
async function createRequest(request,response){
  const user=await getUserFromRequest(request);
  if(!user)return sendJson(response,401,{success:false,message:'Please log in first'});
  const input=request.body||{};
  const paymentReference=normalize(input.payment_reference||input.reference);
  const payerName=normalize(input.payer_name||input.payerName);
  const phone=normalize(input.phone);
  if(!paymentReference)return sendJson(response,400,{success:false,message:'Payment Reference / Session ID is required'});
  if(!payerName)return sendJson(response,400,{success:false,message:'Account Name Used For Payment is required'});
  const receiptUrl=await uploadReceipt(user.id,input.receipt||null);
  const payload={user_id:user.id,email:user.email||'',payer_name:payerName,phone:phone||null,payment_reference:paymentReference,receipt_url:receiptUrl,amount:EXPECTED_AMOUNT,status:'pending'};
  await supabaseRequest('/rest/v1/manual_payment_requests',{method:'POST',body:payload,prefer:'return=minimal'});
  return sendJson(response,200,{success:true,message:'Payment submitted successfully. Pending Verification.',status:'pending'});
}
async function listOwnRequests(request,response){
  const user=await getUserFromRequest(request);
  if(!user)return sendJson(response,401,{success:false,message:'Please log in first'});
  const rows=await supabaseRequest('/rest/v1/manual_payment_requests?select=status,created_at,reviewed_at&user_id=eq.'+encodeURIComponent(user.id)+'&order=created_at.desc&limit=1');
  const latest=Array.isArray(rows)&&rows.length?rows[0]:null;
  return sendJson(response,200,{success:true,request:latest});
}
async function listRequests(request,response){
  if(request.query&&request.query.mine)return listOwnRequests(request,response);
  const admin=await requireAdmin(request,response);
  if(!admin)return;
  const rows=await supabaseRequest('/rest/v1/manual_payment_requests?select=*&order=created_at.desc&limit=100');
  const requests=await addSignedReceiptLinks(rows||[]);
  const summary=await getAdminSummary();
  return sendJson(response,200,{success:true,requests,summary});
}
async function reviewRequest(request,response){
  const admin=await requireAdmin(request,response);
  if(!admin)return;
  const input=request.body||{};
  const id=normalize(input.id);
  const action=normalize(input.action).toLowerCase();
  if(!id||!['approve','reject'].includes(action))return sendJson(response,400,{success:false,message:'Request id and valid action are required'});
  const rows=await supabaseRequest('/rest/v1/manual_payment_requests?select=*&id=eq.'+encodeURIComponent(id)+'&limit=1');
  const row=Array.isArray(rows)&&rows.length?rows[0]:null;
  if(!row)return sendJson(response,404,{success:false,message:'Manual payment request not found'});
  const now=new Date().toISOString();
  if(action==='reject'){
    await supabaseRequest('/rest/v1/manual_payment_requests?id=eq.'+encodeURIComponent(id),{method:'PATCH',body:{status:'rejected',reviewed_at:now,reviewed_by:admin.email||admin.id},prefer:'return=minimal'});
    return sendJson(response,200,{success:true,status:'rejected'});
  }
  await ensureReferenceAvailable(row.payment_reference,row.user_id,input.confirmReassign===true);
  const existing=await supabaseRequest('/rest/v1/user_subscriptions?select=id&user_id=eq.'+encodeURIComponent(row.user_id)+'&limit=1');
  const subscriptionPayload={user_id:row.user_id,email:row.email,status:'active',verified:true,payment_reference:row.payment_reference,amount:EXPECTED_AMOUNT,currency:'NGN',payment_method:'bank_transfer',paid_at:now,updated_at:now};
  if(Array.isArray(existing)&&existing.length){
    await supabaseRequest('/rest/v1/user_subscriptions?id=eq.'+encodeURIComponent(existing[0].id),{method:'PATCH',body:subscriptionPayload,prefer:'return=minimal'});
  }else{
    await supabaseRequest('/rest/v1/user_subscriptions',{method:'POST',body:subscriptionPayload,prefer:'return=minimal'});
  }
  await supabaseRequest('/rest/v1/manual_payment_requests?id=eq.'+encodeURIComponent(id),{method:'PATCH',body:{status:'approved',reviewed_at:now,reviewed_by:admin.email||admin.id},prefer:'return=minimal'});
  return sendJson(response,200,{success:true,status:'approved',message:'Payment Verified. Unlimited CBT Access Activated.'});
}

module.exports=async function handler(request,response){
  try{
    if(request.method==='POST')return createRequest(request,response);
    if(request.method==='GET')return listRequests(request,response);
    if(request.method==='PATCH')return reviewRequest(request,response);
    response.setHeader('Allow','GET, POST, PATCH');
    return sendJson(response,405,{success:false,message:'Method not allowed'});
  }catch(error){
    if(error.requiresConfirmation)return sendJson(response,error.statusCode||409,{success:false,requiresConfirmation:true,message:error.message});
    console.error('Manual payment request error:',error);
    const safeMessage=error.statusCode&&error.statusCode<500?error.message:'Manual payment request failed';
    return sendJson(response,error.statusCode||500,{success:false,message:safeMessage});
  }
}
