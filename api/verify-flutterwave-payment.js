const SUPABASE_URL = process.env.SUPABASE_URL;
const EXPECTED_AMOUNT = 2000;
const EXPECTED_CURRENCY = 'NGN';
const FLUTTERWAVE_BASE_URL = 'https://api.flutterwave.com/v3';
const GA4_MP_ENDPOINT = 'https://www.google-analytics.com/mp/collect';
const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_ID || process.env.VITE_GA_ID || 'G-GG2J53LC75';
const GA_API_SECRET = process.env.GA_API_SECRET || '';

function sendJson(response, statusCode, payload){response.status(statusCode).json(payload)}
function normalizeReference(value){return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''}
function isNumeric(value){return /^\d+$/.test(value)}
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
async function callFlutterwaveVerify(path,secretKey){const res=await fetch(FLUTTERWAVE_BASE_URL+path,{method:'GET',headers:{Authorization:'Bearer '+secretKey,'Content-Type':'application/json'}});return {ok:res.ok,statusCode:res.status,body:await readJson(res)}}
function getVerificationFailure(body){
  const data=body&&body.data;
  const apiStatus=String((body&&body.status)||'').toLowerCase();
  if(!body||apiStatus!=='success'||!data)return 'Reference not found';
  const paymentStatus=String((data&&data.status)||'').toLowerCase();
  if(paymentStatus!=='successful')return 'Payment not successful';
  const amount=Number(data&&data.amount);
  if(amount!==EXPECTED_AMOUNT)return 'Amount does not match ₦2,000';
  const currency=String((data&&data.currency)||'').toUpperCase();
  if(currency!==EXPECTED_CURRENCY)return 'Currency is not NGN';
  return null;
}
function getCustomerEmail(data){return String((data&&data.customer&&(data.customer.email||data.customer.email_address))||'').trim().toLowerCase()}
function userEmailMatchesPayment(data,user){const paymentEmail=getCustomerEmail(data);const userEmail=String((user&&user.email)||'').trim().toLowerCase();return !paymentEmail||!userEmail||paymentEmail===userEmail}
function publicVerificationPayload(data){return {success:true,verified:true,amount:EXPECTED_AMOUNT,currency:EXPECTED_CURRENCY,status:String(data.status||'successful'),verifiedAt:new Date().toISOString()}}
async function ensureReferenceAvailable(reference,userId){
  const rows=await supabaseRequest('/rest/v1/user_subscriptions?select=id,user_id&payment_reference=eq.'+encodeURIComponent(reference)+'&status=eq.active&limit=1');
  const duplicate=Array.isArray(rows)?rows.find(row=>row.user_id!==userId):null;
  if(duplicate){const error=new Error('This payment reference is already linked to another subscription');error.statusCode=409;throw error}
}
async function upsertSubscription(user,data,reference){
  await ensureReferenceAvailable(reference,user.id);
  const now=new Date().toISOString();
  const payload={
    user_id:user.id,
    email:user.email||null,
    status:'active',
    verified:true,
    payment_method:'flutterwave',
    payment_reference:reference,
    amount:EXPECTED_AMOUNT,
    currency:EXPECTED_CURRENCY,
    paid_at:data.created_at||data.paid_at||now,
    updated_at:now
  };
  const rows=await supabaseRequest('/rest/v1/user_subscriptions?on_conflict=user_id',{method:'POST',body:payload,prefer:'resolution=merge-duplicates,return=representation'});
  return Array.isArray(rows)&&rows[0]?rows[0]:null;
}

async function sendGA4PurchaseEvent({transactionId,value,currency,clientId,userId}){
  if(!GA_MEASUREMENT_ID||!GA_API_SECRET)return;
  const resolvedClientId=normalizeReference(clientId)||(userId?String(userId):'server.'+Date.now());
  const url=GA4_MP_ENDPOINT+'?measurement_id='+encodeURIComponent(GA_MEASUREMENT_ID)+'&api_secret='+encodeURIComponent(GA_API_SECRET);
  const payload={
    client_id:resolvedClientId,
    ...(userId?{user_id:String(userId)}:{}),
    events:[{
      name:'purchase',
      params:{
        transaction_id:String(transactionId),
        value:Number(value)||EXPECTED_AMOUNT,
        currency:String(currency||EXPECTED_CURRENCY),
        items:[{
          item_id:'tsc_rules_cbt_subscription',
          item_name:'TSC Rules CBT Unlimited Subscription',
          price:Number(value)||EXPECTED_AMOUNT,
          quantity:1
        }]
      }
    }]
  };
  try{
    const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    console.info('GA4 Measurement Protocol purchase sent',{transaction_id:transactionId,statusCode:res.status});
  }catch(err){
    console.error('GA4 Measurement Protocol error',{transaction_id:transactionId,message:err.message});
  }
}

async function findUserByEmail(email){
  if(!email)return null;
  try{
    const rows=await supabaseRequest('/rest/v1/user_subscriptions?select=user_id,email&email=ilike.'+encodeURIComponent(email)+'&limit=1');
    if(Array.isArray(rows)&&rows[0]&&rows[0].user_id)return {id:rows[0].user_id,email:rows[0].email||email};
  }catch{}
  try{
    const data=await supabaseRequest('/auth/v1/admin/users?per_page=1000');
    const users=(data&&data.users)||[];
    const match=users.find(u=>String(u.email||'').trim().toLowerCase()===email.toLowerCase());
    if(match)return {id:match.id,email:match.email};
  }catch{}
  return null;
}

module.exports=async function handler(request,response){
  if(request.method!=='POST'&&request.method!=='GET'){
    response.setHeader('Allow','POST, GET');
    return sendJson(response,405,{success:false,message:'Method not allowed'});
  }
  const secretKey=process.env.FLW_SECRET_KEY;
  if(!secretKey)return sendJson(response,500,{success:false,message:'Payment verification is not configured'});
  const webhookSignature=request.headers['verif-hash']||request.headers['Verif-Hash']||'';
  const expectedWebhookHash=process.env.FLW_WEBHOOK_SECRET_HASH||process.env.FLW_SECRET_HASH||'';
  const isWebhookRequest=Boolean(webhookSignature);
  if(isWebhookRequest&&expectedWebhookHash&&webhookSignature!==expectedWebhookHash){
    return sendJson(response,401,{success:false,message:'Invalid webhook signature'});
  }
  let user=await getUserFromRequest(request);
  const input=request.method==='GET'?request.query:(request.body||{});
  const webhookData=input&&input.data&&typeof input.data==='object'?input.data:null;
  const transactionId=normalizeReference(input.transaction_id||input.id||(webhookData&&webhookData.id));
  const txRef=normalizeReference(input.tx_ref||input.reference||(webhookData&&webhookData.tx_ref));
  const gaClientId=normalizeReference(input.ga_client_id);
  if(!user&&isWebhookRequest&&(!expectedWebhookHash||webhookSignature===expectedWebhookHash)){
    const webhookEmail=getCustomerEmail(webhookData||input);
    user=await findUserByEmail(webhookEmail);
  }
  if(!user)return sendJson(response,401,{success:false,message:'Please log in first'});
  if(!transactionId&&!txRef)return sendJson(response,400,{success:false,message:'Reference not found'});
  console.info('Flutterwave verification started',{user_id:user.id,transaction_id:transactionId||null,tx_ref:txRef||null,isWebhook:isWebhookRequest});
  try{
    const attempts=[];
    if(transactionId&&isNumeric(transactionId))attempts.push({type:'transaction_id',value:transactionId,path:'/transactions/'+encodeURIComponent(transactionId)+'/verify'});
    if(txRef)attempts.push({type:'tx_ref',value:txRef,path:'/transactions/verify_by_reference?tx_ref='+encodeURIComponent(txRef)});
    if(!attempts.length)return sendJson(response,400,{success:false,message:'Reference not found'});
    let finalMessage='Reference not found';
    for(const attempt of attempts){
      const result=await callFlutterwaveVerify(attempt.path,secretKey);
      const failure=getVerificationFailure(result.body);
      console.info('Flutterwave verification result',{user_id:user.id,attempt:attempt.type,statusCode:result.statusCode,apiStatus:result.body&&result.body.status||null,paymentStatus:result.body&&result.body.data&&result.body.data.status||null,amount:result.body&&result.body.data&&result.body.data.amount||null,currency:result.body&&result.body.data&&result.body.data.currency||null});
      if(!failure){
        const data=result.body.data;
        if(!userEmailMatchesPayment(data,user)){finalMessage='Payment does not belong to this logged-in account';break}
        const reference=String(data.tx_ref||txRef||data.flw_ref||transactionId);
        try{
          const subscription=await upsertSubscription(user,data,reference);
          console.info('Subscription upsert success',{user_id:user.id,subscription_id:subscription&&subscription.id||null,payment_method:'flutterwave'});
          await sendGA4PurchaseEvent({
            transactionId:String(data.id||transactionId||reference),
            value:Number(data.amount)||EXPECTED_AMOUNT,
            currency:String(data.currency||EXPECTED_CURRENCY).toUpperCase(),
            clientId:gaClientId,
            userId:user.id
          });
          return sendJson(response,200,publicVerificationPayload(data));
        }catch(dbError){
          console.error('Subscription upsert failure',{user_id:user.id,transaction_id:transactionId||null,tx_ref:txRef||null,message:dbError.message,statusCode:dbError.statusCode||null,details:dbError.details||null});
          return sendJson(response,202,{...publicVerificationPayload(data),activationPending:true,message:'Payment was received, but access activation is still processing. Please wait briefly or contact admin@qibmauz.com.'});
        }
      }
      if(failure!=='Reference not found'){finalMessage=failure;break}
    }
    return sendJson(response,400,{success:false,message:finalMessage});
  }catch(error){
    console.error('Flutterwave verification error:',{user_id:user.id,transaction_id:transactionId||null,tx_ref:txRef||null,message:error.message});
    return sendJson(response,error.statusCode||500,{success:false,message:error.statusCode&&error.statusCode<500?error.message:'Payment verification failed'});
  }
}
