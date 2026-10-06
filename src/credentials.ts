import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';

/** 凭据值会原样写进 .env 的双引号里，所以必须拒绝能改变文件结构的字符。 */
const UNSAFE=/["'\\\r\n]/;

/**
 * 校验一个准备写进 .env 的值。
 * 换行是这里最危险的字符：它能凭空造出一个新变量（比如 `ALGORITHM_DX_DB_PATH`），
 * 把「填 Cookie」变成「改写程序配置」。引号与反斜杠则会让解析结果超出预期。
 */
export function assertSafeEnvValue(key:string,value:string):string{
  const trimmed=value.trim();
  if(!trimmed)throw new Error(`${key} value is empty`);
  if(UNSAFE.test(trimmed))throw new Error(`${key} value must not contain quotes, backslashes or line breaks`);
  return trimmed;
}

/**
 * 兜底脱敏：万一某个适配器把凭据拼进了报错信息，也不让它落进数据库与同步日志。
 * 这是一道保险，不是许可 —— 适配器本身仍然不该拼接凭据。
 */
export function redactSecrets(text:string):string{
  return text
    .replace(/(\bcookie\s*:\s*)[^\r\n]+/gi,'$1[redacted]')
    .replace(/(\bauthorization\s*:\s*)[^\r\n]+/gi,'$1[redacted]')
    .replace(/(__client_id\s*=\s*)[^;\s"']+/gi,'$1[redacted]')
    .replace(/(\b(?:LEETCODE_SESSION|csrftoken|cf_clearance)\s*=\s*)[^;\s"']+/gi,'$1[redacted]')
    .replace(/(\b(?:password|passwd|token|api[_-]?key|secret)\s*[=:]\s*)[^\s;,&]+/gi,'$1[redacted]');
}

export type EnvWriteOutcome='updated'|'uncommented'|'appended';

/**
 * 只回答「这个变量配了没有」，**不返回值本身**。
 *
 * 面板需要显示「凭据 已配置 / 未配置」，但没有任何理由把凭据送进 HTTP 响应体 ——
 * 一旦进了响应体，它就同时进了浏览器缓存、开发者工具和可能的截图。
 *
 * 读文件而不是读 process.env：面板刚写完 .env 时，进程环境变量不会随之更新，
 * 只看 process.env 会一直显示「未配置」。
 */
export function isEnvVarSet(file:string,key:string,env:NodeJS.ProcessEnv=process.env):boolean{
  const external=env[key];
  if(typeof external==='string'&&external.trim())return true;
  if(!existsSync(file))return false;
  const pattern=new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`);
  for(const line of readFileSync(file,'utf8').split(/\r?\n/)){
    const match=pattern.exec(line);
    // 注释掉的模板行（`# KEY=…`）前面有 #，这里的 ^\s*KEY 匹配不到，正是想要的行为。
    if(match)return match[1].trim().replace(/^["']|["']$/g,'').length>0;
  }
  return false;
}

/**
 * 读 .env 里的 KEY=VALUE。只认本项目自己写出的格式（`KEY="值"` 或 `KEY=值`），
 * 注释行与空值行跳过 —— 与 `isEnvVarSet` 用的是同一套判断。
 */
export function readEnvFile(file:string):Record<string,string>{
  if(!existsSync(file))return{};
  const values:Record<string,string>={};
  for(const line of readFileSync(file,'utf8').split(/\r?\n/)){
    const match=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if(!match)continue;
    const value=match[2].trim().replace(/^["']|["']$/g,'').trim();
    if(value)values[match[1]]=value;
  }
  return values;
}

/**
 * 以 .env 为准的环境快照：先铺 process.env，再用文件里的值覆盖。
 *
 * 为什么不用 `process.loadEnvFile()`：它**不覆盖已经存在的环境变量**，而这里恰恰需要覆盖 ——
 * 面板刚把凭据写进 .env 时，进程里那份（启动时加载的）还是旧的，只看 process.env 会一直
 * 报「没配 Cookie」，直到重启服务。凭据的唯一出处是 .env，那就以它为准。
 * 副作用是「手改 .env 后不用重启面板」，这也正是想要的。
 */
export function envFor(file:string):NodeJS.ProcessEnv{
  return{...process.env,...readEnvFile(file)};
}

/**
 * 在 .env 里写入或更新一个变量，其余行与注释原样保留。
 * 命中顺序：活动行 `KEY=` → 注释模板行 `# KEY=` → 追加到文件末尾。
 * 命中注释模板是有意为之：.env 模板里那行占位注释会被替换成真实配置，而不是留下一份过期说明。
 */
export function upsertEnvVar(file:string,key:string,value:string):EnvWriteOutcome{
  const text=existsSync(file)?readFileSync(file,'utf8'):'';
  const eol=text.includes('\r\n')?'\r\n':'\n';
  const lines=text?text.split(/\r?\n/):[];
  const active=new RegExp(`^\\s*${key}\\s*=`),commented=new RegExp(`^\\s*#\\s*${key}\\s*=`),line=`${key}="${value}"`;
  let outcome:EnvWriteOutcome='appended';
  for(let i=0;i<lines.length;i++){
    if(active.test(lines[i])){lines[i]=line;outcome='updated';break;}
    if(commented.test(lines[i])){lines[i]=line;outcome='uncommented';break;}
  }
  if(outcome==='appended'){
    if(lines.length&&lines[lines.length-1].trim())lines.push('');
    lines.push(line);
  }
  while(lines.length&&!lines[lines.length-1].trim())lines.pop();
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary,lines.join(eol)+eol,{encoding:'utf8',mode:0o600,flag:'wx'});
    renameSync(temporary,file);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return outcome;
}

/** Save related settings together so a key cannot be paired with an old secret. */
export function upsertEnvVars(file:string, values:Record<string,string>):void {
  const temporary=file+'.'+randomUUID()+'.settings.tmp';
  try {
    writeFileSync(temporary,existsSync(file)?readFileSync(file,'utf8'):'',{encoding:'utf8',mode:0o600,flag:'wx'});
    for(const [key,value] of Object.entries(values))upsertEnvVar(temporary,key,value);
    renameSync(temporary,file);
  } finally { if(existsSync(temporary))unlinkSync(temporary); }
}
