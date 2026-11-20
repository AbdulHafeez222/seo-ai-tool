(async()=>{
 const status=document.getElementById('checkoutStatus');
 try{
  const transactionId=new URLSearchParams(location.search).get('_ptxn');
  if(!/^txn_[a-z0-9]{26}$/.test(transactionId||''))throw new Error('A valid test transaction is required.');
  const response=await fetch('/billing/status');const config=await response.json();
  if(!response.ok||config.mode!=='sandbox'||!config.clientToken?.startsWith('test_'))throw new Error('Test checkout is unavailable. Log in and return to plans.');
  const script=document.createElement('script');script.src='https://cdn.paddle.com/paddle/v2/paddle.js';
  await new Promise((resolve,reject)=>{script.onload=resolve;script.onerror=reject;document.head.append(script);});
  window.Paddle.Environment.set('sandbox');window.Paddle.Initialize({token:config.clientToken});window.Paddle.Checkout.open({transactionId});
  status.textContent='Finish the sandbox checkout, then return to plans. Access changes only after the server verifies a subscription event.';
 }catch(error){status.textContent=error.message||'Test checkout could not load.';}
})();
