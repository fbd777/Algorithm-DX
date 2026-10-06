import fs from 'node:fs/promises';
import {FIT_MIN_Q,FIT_MAX_Q} from './core.mjs';
const root='results/cf-study';
const summary=JSON.parse(await fs.readFile(root+'/summary.json','utf8'));
const rows=summary.baseline.filter(r=>r.q>=FIT_MIN_Q&&r.q<=FIT_MAX_Q&&r.samples>=100);
if(rows.length<4)throw Error('Need at least four bins with >=100 samples for fitting');
const models=['km','success'];
const value=(r,m)=>m==='km'?r.t97KmSeconds:r.successP50Seconds;
const weight=r=>Math.max(1,Number.isFinite(r.effectiveSamples)?r.effectiveSamples:(Number.isFinite(r.samples)?r.samples:1));
function solve(A,b){const n=b.length,M=A.map((row,i)=>[...row,b[i]]);for(let c=0;c<n;c++){let p=c;for(let i=c+1;i<n;i++)if(Math.abs(M[i][c])>Math.abs(M[p][c]))p=i;[M[c],M[p]]=[M[p],M[c]];if(Math.abs(M[c][c])<1e-10)continue;for(let i=c+1;i<n;i++){const f=M[i][c]/M[c][c];for(let j=c;j<=n;j++)M[i][j]-=f*M[c][j];}}const x=Array(n).fill(0);for(let i=n-1;i>=0;i--){let s=M[i][n];for(let j=i+1;j<n;j++)s-=M[i][j]*x[j];x[i]=Math.abs(M[i][i])<1e-10?0:s/M[i][i];}return x;}
function fit(data,degree){const x0=1400,s=600,pow=x=>Array.from({length:degree+1},(_,i)=>((x-x0)/s)**i);const A=Array.from({length:degree+1},()=>Array(degree+1).fill(0)),b=Array(degree+1).fill(0);for(const r of data){const p=pow(r.q),w=weight(r);for(let i=0;i<p.length;i++){b[i]+=w*p[i]*r.y;for(let j=0;j<p.length;j++)A[i][j]+=w*p[i]*p[j];}}const beta=solve(A,b),predict=q=>pow(q).reduce((a,v,i)=>a+v*beta[i],0);return {degree,beta,predict};}
function score(data,degree){let se=0,sw=0;for(let i=0;i<data.length;i++){const train=data.filter((_,j)=>j!==i),m=fit(train,degree),r=data[i],e=m.predict(r.q)-r.y;se+=weight(r)*e*e;sw+=weight(r);}return Math.sqrt(se/sw);}
const fitted=[],metrics=[];
for(const model of models){const data=rows.filter(r=>value(r,model)!=null).map(r=>({q:r.q,y:value(r,model)}));let best=null;for(const degree of [1,2,3]){const cv=score(data,degree);metrics.push({model,degree,loocvRmseSeconds:cv});if(!best||cv<best.cv)best={degree,cv};}const m=fit(data,best.degree);for(let q=FIT_MIN_Q;q<=FIT_MAX_Q;q+=100)fitted.push({model,q,observedSeconds:data.find(r=>r.q===q)?.y??null,fittedSeconds:m.predict(q),residualSeconds:data.find(r=>r.q===q)?data.find(r=>r.q===q).y-m.predict(q):null});}
const csv=(rows)=>{const keys=Object.keys(rows[0]);return keys.join(',')+'\n'+rows.map(r=>keys.map(k=>r[k]??'').join(',')).join('\n')+'\n';};
await fs.writeFile(root+'/t97_fitted.csv',csv(fitted));
await fs.writeFile(root+'/fit_metrics.csv',csv(metrics));
await fs.writeFile(root+'/fit.json',JSON.stringify({kind:'fitted',method:'weighted polynomial selected by leave-one-rating-bin-out RMSE',weight:'effective sample size per rating bin',inputBins:rows.map(r=>({q:r.q,n:r.samples,effectiveSamples:r.effectiveSamples})),metrics,selected:Object.fromEntries(models.map(model=>{const m=metrics.filter(x=>x.model===model).sort((a,b)=>a.loocvRmseSeconds-b.loocvRmseSeconds)[0];return [model,m];})),fitted},null,2));
console.log(JSON.stringify({bins:rows.length,metrics,selected:Object.fromEntries(models.map(model=>[model,metrics.filter(x=>x.model===model).sort((a,b)=>a.loocvRmseSeconds-b.loocvRmseSeconds)[0]]))},null,2));
