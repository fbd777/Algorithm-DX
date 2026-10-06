import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cfRatingColor} from '../public/cf-rating-colors.js';

test('CF problem colors switch at handle-color boundaries and preserve unrated state',()=>{
  for(const [rating,tone] of [[0,'gray'],[1199,'gray'],[1200,'green'],[1399,'green'],
    [1400,'cyan'],[1599,'cyan'],[1600,'blue'],[1899,'blue'],[1900,'violet'],[2099,'violet'],
    [2100,'orange'],[2399,'orange'],[2400,'red'],[3000,'red'],[3900,'red']]) {
    assert.equal(cfRatingColor(rating).tone,tone,`rating ${rating}`);
  }
  for(const rating of [null,undefined,NaN,Infinity,-1]) assert.equal(cfRatingColor(rating).tone,'unrated');
});
