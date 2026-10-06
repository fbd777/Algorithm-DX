// Display-only queries. Scores come from the server's single scoring implementation.
export function queryRecords(records, filters = {}) {
  const query = (filters.query ?? '').trim().toLowerCase();
  const ranges = [['difficulty','problemRating'], ['achievement','achievement'], ['seconds','recordedSeconds']];
  for (const [name] of ranges) {
    const min = filters[name+'Min'], max = filters[name+'Max'];
    for (const value of [min,max]) if (value != null && (!Number.isFinite(value) || value < 0)) throw new Error('筛选范围须为非负数字');
    if (min != null && max != null && min > max) throw new Error('范围下限不能大于上限');
  }
  const rows = records.filter(item => {
    if (query && !`${item.problemId} ${item.problemTitle ?? ''}`.toLowerCase().includes(query)) return false;
    if (filters.state && filters.state !== 'all' && item.state !== filters.state) return false;
    if (filters.rank === 'other') {
      if (!item.score || item.score.achievementShown >= 97) return false;
    } else if (filters.rank && filters.rank !== 'all' && item.score?.rank !== filters.rank) return false;
    const releasedYear = item.releasedAt == null ? null : new Date(item.releasedAt * 1000).getFullYear();
    if (filters.partition === 'old' && releasedYear != null && releasedYear >= filters.year) return false;
    if (filters.partition === 'new' && releasedYear !== filters.year) return false;
    for (const [name,key] of ranges) {
      const value = key === 'achievement' ? item.score?.achievementShown : item[key];
      const min = filters[name+'Min'], max = filters[name+'Max'];
      if ((min != null || max != null) && value == null) return false;
      if ((min != null && value < min) || (max != null && value > max)) return false;
    }
    return true;
  });
  const [key,direction] = (filters.sort ?? 'rating_desc').split('_');
  const valueOf = item => ({rating:item.score?.rating,achievement:item.score?.achievementShown,difficulty:item.problemRating,
    seconds:item.recordedSeconds,date:item.solvedAt,problem:item.problemId})[key];
  return rows.sort((a,b) => {
    const av=valueOf(a),bv=valueOf(b);
    // Unrated values always go last, for either direction.
    if (av == null && bv != null) return 1;
    if (bv == null && av != null) return -1;
    const difference = typeof av === 'string' ? av.localeCompare(bv,undefined,{numeric:true}) : (av ?? 0)-(bv ?? 0);
    return difference * (direction === 'asc' ? 1 : -1) || a.problemId.localeCompare(b.problemId,undefined,{numeric:true});
  });
}

export function recordsCsv(records) {
  const cell = value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"'+text.replaceAll('"','""')+'"';
  };
  return '\uFEFF'+[['题号','题名','难度','完成度(%)','评级','单题Rating','用时(秒)','状态'],
    ...records.map(r=>[r.problemId,r.problemTitle,r.problemRating,r.score?.achievementShown,r.score?.rank,r.score?.rating,r.recordedSeconds,r.state])]
    .map(row=>row.map(cell).join(',')).join('\r\n');
}
