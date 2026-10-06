import { openDatabase } from '../src/db/database.ts';
import { createFactory } from '../src/fetchers/registry.ts';

// Public, read-only samples. Does not create users or persist sample submissions.
const db=openDatabase(':memory:');
try{
  const factory=createFactory(db,{});
  for(const [platform,handle] of [['codeforces','tourist'],['leetcode','leetcode'],['leetcode-cn','endlesscheng'],['atcoder','chokudai']]){
    try{
      const result=await factory({id:0,user_id:0,platform,handle}).fetch_batch(handle,{limit:2,maxPages:1});
      console.log(JSON.stringify({platform,status:'ok',records:result.submissions.length,acceptedOnly:result.acceptedOnly,scope:result.scope,complete:result.complete}));
    }catch(e){console.error(JSON.stringify({platform,status:'failed',message:e instanceof Error?e.message:'unknown'}));process.exitCode=1;}
  }
}finally{db.close();}
