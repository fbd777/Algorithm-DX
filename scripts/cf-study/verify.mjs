// 可复现性核对：从本地官方响应缓存离线重建，两次结果必须逐字节相同。
//
// 这里哈希的是**文件字节**而不是「parse 回来再 stringify 的字符串」。
// 后者要在内存里再拼一个和文件同样大的字符串，而 samples.json 正朝 V8 的单字符串上限
// （约 512 MiB）长 —— 到那一步核对会先于数据本身崩掉。字节相同是更强的条件，
// 而且 build.mjs 的写出顺序是确定的。
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const files=['candidates','samples'];
const digest=()=>Object.fromEntries(files.map(name=>[name,createHash('sha256').update(fs.readFileSync('data/cf-study/processed/'+name+'.json')).digest('hex')]));
const before=digest();
// 重建要读 69 场的 standings + 逐提交 status（最大一场解压后几百 MB），默认堆装不下 ——
// Node 会在中途 OOM，看上去像「重建失败」，其实是内存。所以这里显式抬堆。
const run=spawnSync(process.execPath,['--max-old-space-size=10240','scripts/cf-study/build.mjs'],{stdio:'inherit'});
if(run.status!==0)throw Error('Offline rebuild failed');
const after=digest();
const identical=files.every(k=>before[k]===after[k]);
fs.mkdirSync('results/cf-study',{recursive:true});
fs.writeFileSync('results/cf-study/reproducibility.json',JSON.stringify({checkedAt:new Date().toISOString(),node:process.version,method:'SHA256 of processed/*.json bytes before/after fully offline rebuild',identical,before,after},null,2));
if(!identical)throw Error('Offline rebuilt records differ; inspect reproducibility.json');
console.log('PASS: candidates and samples exactly reproduced from cached official responses.');
