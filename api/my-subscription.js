const SUPABASE_URL = process.env.SUPABASE_URL;

function sendJson(response,statusCode,payload){response.status(statusCode).json(payload)}
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
  if(!res.ok){const error=new Error('Supabase request failed');error.statusCode=res.status;error.details=data;throw error}
  return data;
}
async function getUserFromRequest(request){const token=getBearerToken(request);if(!token)return null;try{return await supabaseRequest('/auth/v1/user',{token})}catch{return null}}

module.exports=async function handler(request,response){
  if(request.method!=='GET'){response.setHeader('Allow','GET');return sendJson(response,405,{success:false,message:'Method not allowed'})}
  try{
    const user=await getUserFromRequest(request);
    if(!user)return sendJson(response,401,{success:false,message:'Please log in first'});
    const rows=await supabaseRequest('/rest/v1/user_subscriptions?select=status,verified,amount,currency,payment_method,paid_at&user_id=eq.'+encodeURIComponent(user.id)+'&limit=1');
    const subscription=Array.isArray(rows)&&rows.length?rows[0]:null;
    return sendJson(response,200,{success:true,subscription});
  }catch(error){
    console.error('My subscription lookup failed:',error);
    return sendJson(response,500,{success:false,message:'Subscription check failed'});
  }
}
