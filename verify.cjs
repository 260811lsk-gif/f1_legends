const fs=require('node:fs'),vm=require('node:vm');
for(const p of ['api/game.js','lib/service.cjs','lib/state.lua','vercel.json','public/index.html'])if(!fs.existsSync(p))throw Error('Missing '+p);
const html=fs.readFileSync('public/index.html','utf8');
for(const m of html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g))if(m[1].trim()&&!m[1].trim().startsWith('{'))new vm.Script(m[1]);
new vm.Script(fs.readFileSync('api/game.js','utf8'));new vm.Script(fs.readFileSync('lib/service.cjs','utf8'));JSON.parse(fs.readFileSync('vercel.json','utf8'));
console.log('Vercel package: game, function and routes verified.');
