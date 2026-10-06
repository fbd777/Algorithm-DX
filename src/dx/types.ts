/** DX Rating 相关的共享类型。口径与公式见 src/dx/rating.ts 顶部注释。 */

/** 由 scripts/cf-study/export-dx-curve.mjs 生成并填充的 T97 曲线。 */
export interface DxCurve {
  model: string;
  sourceFile: string;
  sourceSha256: string;
  generatedAt: string;
  /** 曲线适用范围的下界（题目 Rating）。 */
  fitMinQ: number;
  /** 曲线适用范围的上界（题目 Rating）。 */
  fitMaxQ: number;
  /** 相邻网格点的 Rating 间距（25）。 */
  gridStepQ: number;
  /**
   * 统计实验的 `productionReady` 标记：三条预注册判据（主推优于常数基线、
   * 平滑与单调约束的代价可接受、时间留出方向一致）全过才置 `true`。
   * 面板必须把状态显示出来 —— `false` 是黄底警示，`true` 也要留一条中性状态条
   * 交代曲线来源与指纹。判据明细见 `results/cf-study/VALIDATION.md`。
   */
  productionReady: boolean;
  productionReadyBasis: string;
  /** [题目 Rating, T97 秒]，按 Rating 升序、等步长。 */
  points: readonly (readonly [number, number])[];
}

/** 一道题的原始信息（来自 submissions 表，只取 AC 的 CF 题）。 */
export interface DxEntry {
  /** Verified original identity. Copies compete for one B50 slot. */
  canonicalProblemId?: string;
  platform: string;
  problemId: string;
  problemTitle: string;
  problemUrl: string | null;
  /**
   * CF 题目 Rating，DX 口径里充当难度锚点（对应 maimai 的「定数」那一层）。
   * 缺失时无法计分。
   */
  problemRating: number | null;
  /** 该题最早的 AC 时间（epoch 秒）。只用于排序与显示，**不参与分板**。 */
  solvedAt: number;
  /**
   * **出题日期** = 该题所属比赛的开始时间（epoch 秒）。
   *
   * 「本年度新题」判的是它，不是 AC 时间：2026 年切掉一道 2013 年的题，它进旧题区。
   * 查不到时为 null（比赛不在 `contests` 表里，例如 gym），这种题**按旧题处理**。
   */
  releasedAt: number | null;
  /** 用户填写的完成用时（秒）。没填就是 null，没填的题不进榜。 */
  recordedSeconds: number | null;
}

/** 算出单题 rating 之后的结果。 */
export interface DxScore {
  /** 查到 / 外推得到的 T97，单位秒。 */
  t97Seconds: number;
  /** T97 是否落在拟合区间之外（外推）。 */
  extrapolated: 'below' | 'above' | null;
  /** 完成度百分数；正用时在数学上小于理论极限 101。 */
  achievement: number;
  /** 判定与显示用的完成度：截断到 [0, 101]。 */
  achievementShown: number;
  /** Rank 字母，如 S、SSS+。 */
  rank: string;
  /** 单题 rating（dx 贡献），保留 1 位小数。 */
  rating: number;
  /**
   * 计分系数因子 `A × 评级系数(A) / (97 × 20)`。
   * 用时 = T97 → 1.000；满分（SSS+，100.5%）由 factorFromAchievement 计算（含高完成度增益）。
   */
  factor: number;
}

/** 榜上的一个格子。entry 为 null 表示这个格子空着。 */
export interface DxSlot {
  /** 名次，从 1 开始。 */
  position: number;
  entry: DxEntry | null;
  score: DxScore | null;
}

/** 「待填写用时」清单里的一行。 */
export interface DxPending {
  problemId: string;
  problemTitle: string;
  problemUrl: string | null;
  /**
   * CF 题目 Rating。null = CF 还没公布这道题的评级（刚打完的比赛常见）。
   * 这种题**现在就能填用时**，但评级公布前不进榜 —— 公布后由同步回填，自动计分。
   */
  problemRating: number | null;
  /** 出题日期（epoch 秒）。上面那行的分类依据，界面上直接显示它。 */
  releasedAt: number | null;
  /** 该题最早一次 AC 的时间（epoch 秒）。清单按它倒序。 */
  solvedAt: number;
  /** 填了之后会进哪一区：出题日期不早于本年度起点就是「本年度新题」。 */
  isCurrent: boolean;
  /**
   * 「比赛自动计时」能算出的纯耗时（秒），算不出为 null（前端不显示按钮）。
   *
   * 口径 B（2026-09-21 Ryan 确认）：把比赛中切掉的题**按被切的时间顺序排列**，
   * 逐题自动计算 —— 第 k 题纯耗时 = 自己窗口内最早 AC − 上一道切掉的题的最早 AC
   * （第一道减开赛）。**不按题号顺序**：跳题（A→C→B）也成立，B 的纯耗时就是
   * 「切完 C 之后到切掉 B」的时间。
   * 唯一的守卫：两道 AC 之间**穿插了别的题的提交**（如 WA）时，那段减法区间掺了
   * 别题的时间，不给按钮，宁缺毋滥。计算在 `computeContestAutoSeconds`（纯函数），
   * 数据来自 `listContestTimeline`。赛后练习解的题最早 AC 在窗口外，天然算不出，
   * 与手填不冲突。
   */
  autoSeconds: number | null;
}

/**
 * 「比赛自动计时」的原料行：某用户在**比赛窗口内**的一条提交（含 WA）。
 * 由 `listContestTimeline`（queries.ts）从库里读出，喂给 `computeContestAutoSeconds`
 * （rating.ts，纯函数）算纯耗时。放这里是因为两头都要用，口径只有一处定义。
 */
export interface ContestTimelineRow {
  problemId: string;
  submittedAt: number;
  status: string;
  /** 该题所属比赛的开始时间（UTC 秒）。同一场比赛的所有行相同。 */
  contestStart: number;
  /** 该题所属比赛的时长（秒）。查询已限定非 NULL。 */
  contestDuration: number;
}

/** 整张 DX 榜。 */
export interface DxBoard {
  /** 榜上计入的题目总数（旧题 + 新题），上限 50。 */
  total: number;
  /** 旧题部分（Best35）。 */
  old: DxSlot[];
  /** 本年度新题部分（Best15）。 */
  current: DxSlot[];
  /** 计入旧题格的题数。 */
  oldCount: number;
  /** 计入新题格的题数。 */
  currentCount: number;
  /** 旧题格的 rating 之和 + 新题格的 rating 之和。 */
  rating: number;
}
