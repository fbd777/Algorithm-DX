import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {once} from 'node:events';
import path from 'node:path';
import {gzip,gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {hash} from './core.mjs';
const zip=promisify(gzip),unzip=promisify(gunzip);
export const dataRoot=path.resolve('data/cf-study');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let last=0;
export async function saveJson(file,value){
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file+'.tmp',JSON.stringify(value));
  await fs.rename(file+'.tmp',file);
}
/**
 * 流式写一个大型 JSON 数组：逐项序列化、攒到 1 MB 就落盘。
 *
 * `saveJson` 会先把整个数组拼成一个字符串再写 —— 这个字符串一旦长到约 512 MiB
 * 就会撞上 V8 的单字符串上限抛 RangeError（账本 505 MB 时正是这么炸的）。
 * samples.json 是接下来会长大的那个文件，所以它走这条路。
 */
export async function saveJsonArray(file,items){
  await fs.mkdir(path.dirname(file),{recursive:true});
  const out=createWriteStream(file+'.tmp');
  let buffer='[',first=true;
  const flush=async force=>{
    if(!force&&buffer.length<1048576)return;
    if(!out.write(buffer))await once(out,'drain');
    buffer='';
  };
  for(const item of items){
    buffer+=(first?'':',')+JSON.stringify(item);first=false;
    await flush(false);
  }
  buffer+=']';
  await flush(true);
  out.end();
  await once(out,'finish');
  await fs.rename(file+'.tmp',file);
}
export async function cached(method,params={}){
  const key=hash(method+'?'+new URLSearchParams(params));
  const file=path.join(dataRoot,'raw',method,key+'.json');
  try{return JSON.parse(await fs.readFile(file,'utf8')).result;}catch(e){if(e.code!=='ENOENT')throw e;}
  return JSON.parse((await unzip(await fs.readFile(file+'.gz'))).toString()).result;
}
export async function api(method,params={}){
  try{return await cached(method,params);}catch(e){if(e.code!=='ENOENT')throw e;}
  const query=new URLSearchParams(params),key=hash(method+'?'+query);
  const file=path.join(dataRoot,'raw',method,key+'.json.gz');
  await fs.mkdir(path.dirname(file),{recursive:true});
  for(let attempt=0;attempt<4;attempt++){
    await sleep(Math.max(0,6100-(Date.now()-last)));last=Date.now();
    const url='https://codeforces.com/api/'+method+'?'+query;
    try{
      console.log('GET',method,query.toString());
      const response=await fetch(url,{signal:AbortSignal.timeout(120000)});
      const body=await response.json();
      if(!response.ok||body.status!=='OK')throw Error('HTTP '+response.status+' '+body.comment);
      const bytes=await zip(JSON.stringify({...body,source:url,fetchedAt:new Date().toISOString()}),{level:1});
      await fs.writeFile(file+'.tmp',bytes);await fs.rename(file+'.tmp',file);
      return body.result;
    }catch(e){console.error(e.message);if(attempt===3)throw e;await sleep(6100*2**attempt);}
  }
}
