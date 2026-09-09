// Loopback-only model fixture for transport and Android queue acceptance; never a production provider.
import http from 'node:http';
const server=http.createServer(async(req,res)=>{
  let raw=''; for await(const c of req) raw+=c;
  const body=JSON.parse(raw||'{}');
  if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
  if(!req.url?.endsWith('/chat/completions')){res.writeHead(404);res.end();return;}
  const text='兼容验收通过 Unicode \u{1f642}';
  const chunk=(delta,finish=null)=>({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:finish}]});
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.write('data: '+JSON.stringify(chunk({role:'assistant',content:text}))+'\n\n');
  if (raw.includes('1200')) await new Promise(resolve => { const timer = setTimeout(resolve,30000); res.on('close',()=>{clearTimeout(timer);resolve()}) });
  res.write('data: '+JSON.stringify(chunk({},'stop'))+'\n\n');res.end('data: [DONE]\n\n');
  console.log('fixture_request_ok');
});server.listen(3090,'127.0.0.1');
