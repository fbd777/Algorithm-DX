import { setTimeout as sleep } from 'node:timers/promises';

// Fixed delay after completion: a slow sync never overlaps the next tick.
export async function watchSync(task:()=>Promise<void>,intervalSeconds:number,signal:AbortSignal,wait=sleep):Promise<void>{
  if(!Number.isInteger(intervalSeconds)||intervalSeconds<60)throw new Error('interval must be an integer >= 60 seconds');
  while(!signal.aborted){
    await task();
    if(signal.aborted)break;
    try{await wait(intervalSeconds*1000,undefined,{signal});}
    catch(error){if(!signal.aborted)throw error;}
  }
}
