# 合并题位的定数一致性体检

> 生成：`node scripts/cf-study/slot-check.mjs`。只读缓存，不改口径。

范围：manifest 69 场里 69 场非 IOI 的已完赛比赛，
其中含合并题位（子任务 ≥ 2）的 **38** 个题位、共 77 个题号。

## 表 1 · 每个合并题位里各子任务的定数与题名

| contestId | 比赛 | 题位 | 各子任务 rating | 题名 | 合并后取 | 定数 q | 一致 |
|---:|---|---|---|---|---|---:|---|
| 2127 | Atto Round 1 (Codeforces Round 1041, Div. 1 + Div. 2) | G1+G2 | 3400 / 3500 | Inter Active (Easy Version) + Inter Active (Hard Version) | G2 | 3500 | ❌ |
| 1980 | Codeforces Round 950 (Div. 3) | F1+F2 | 1900 / 2400 | Field Division (easy version) + Field Division (hard version) | F2 | 2400 | ❌ |
| 2039 | CodeTON Round 9 (Div. 1 + Div. 2, Rated, Prizes!) | C1+C2 | 1200 / 1800 | Shohag Loves XOR (Easy Version) + Shohag Loves XOR (Hard Version) | C2 | 1800 | ❌ |
| 2039 | CodeTON Round 9 (Div. 1 + Div. 2, Rated, Prizes!) | F1+F2 | 2800 / 3200 | Shohag Loves Counting (Easy Version) + Shohag Loves Counting (Hard Version) | F2 | 3200 | ❌ |
| 2039 | CodeTON Round 9 (Div. 1 + Div. 2, Rated, Prizes!) | H1+H2 | 3500 / 3500 | Cool Swap Walk (Easy Version) + Cool Swap Walk (Hard Version) | H2 | 3500 | ✅ |
| 1956 | Codeforces Round 939 (Div. 2) | E1+E2 | 2500 / 2700 | Nene vs. Monsters (Easy Version) + Nene vs. Monsters (Hard Version) | E2 | 2700 | ❌ |
| 1972 | Codeforces Round 942 (Div. 2) | D1+D2 | 1400 / 2200 | Reverse Card (Easy Version) + Reverse Card (Hard Version) | D2 | 2200 | ❌ |
| 2180 | Codeforces Global Round 31 (Div. 1 + Div. 2) | F1+F2 | 2800 / 3200 | Control Car (Easy Version) + Control Car (Hard Version) | F2 | 3200 | ❌ |
| 2180 | Codeforces Global Round 31 (Div. 1 + Div. 2) | H1+H2 | 3400 / 3500 | Bug Is Feature (Unconditional Version) + Bug Is Feature (Conditional Version) | H2 | 3500 | ❌ |
| 2164 | Codeforces Global Round 30 (Div. 1 + Div. 2) | F1+F2 | 2600 / 2900 | Chain Prefix Rank (Easy Version) + Chain Prefix Rank (Hard Version) | F2 | 2900 | ❌ |
| 2118 | Codeforces Round 1030 (Div. 2) | D1+D2 | 1700 / 2200 | Red Light, Green Light (Easy version) + Red Light, Green Light (Hard version) | D2 | 2200 | ❌ |
| 2156 | Codeforces Round 1061 (Div. 2) | F1+F2 | 2200 / 3000 | Strange Operation (Easy Version) + Strange Operation (Hard Version) | F2 | 3000 | ❌ |
| 2002 | EPIC Institute of Technology Round August 2024 (Div. 1 + Div. 2) | D1+D2 | 1900 / 2300 | DFS Checker (Easy Version) + DFS Checker (Hard Version) | D2 | 2300 | ❌ |
| 2002 | EPIC Institute of Technology Round August 2024 (Div. 1 + Div. 2) | F1+F2 | 2600 / 2800 | Court Blue (Easy Version) + Court Blue (Hard Version) | F2 | 2800 | ❌ |
| 2071 | Codeforces Round 1007 (Div. 2) | D1+D2 | 1800 / 2500 | Infinite Sequence (Easy Version) + Infinite Sequence (Hard Version) | D2 | 2500 | ❌ |
| 2124 | EPIC Institute of Technology Round Summer 2025 (Codeforces Round 1036, Div. 1 + Div. 2) | F1+F2 | 2300 / 2800 | Appending Permutations (Easy Version) + Appending Permutations (Hard Version) | F2 | 2800 | ❌ |
| 2085 | Codeforces Round 1011 (Div. 2) | F1+F2 | 2600 / 2900 | Serval and Colorful Array (Easy Version) + Serval and Colorful Array (Hard Version) | F2 | 2900 | ❌ |
| 2254 | Codeforces Round 1114 (Div. 3) | C1+C2 | 1000 / 1200 | Marenol (easy version) + Marenol (hard version) | C2 | 1200 | ❌ |
| 2106 | Codeforces Round 1020 (Div. 3) | G1+G2 | 2200 / 2500 | Baudelaire (easy version) + Baudelaire (hard version) | G2 | 2500 | ❌ |
| 2229 | Spectral::Cup 2026 Round 2 (Codeforces Round 1100, Div. 1 + Div. 2) | C1+C2 | 900 / 1400 | We Be Flipping (Easy Version) + We Be Flipping (Hard Version) | C2 | 1400 | ❌ |
| 2163 | Codeforces Round 1063 (Div. 2) | D1+D2 | 2100 / 2500 | Diadrash (Easy Version) + Diadrash (Hard Version) | D2 | 2500 | ❌ |
| 2189 | Codeforces Round 1075 (Div. 2) | C1+C2 | 1300 / 1800 | XOR Convenience (Easy Version) + XOR-convenience (Hard Version) | C2 | 1800 | ❌ |
| 2189 | Codeforces Round 1075 (Div. 2) | D1+D2 | 1900 / 2200 | Little String (Easy Version) + Little String (Hard Version) | D2 | 2200 | ❌ |
| 1919 | Hello 2024 | F1+F2 | 2300 / 2800 | Wine Factory (Easy Version) + Wine Factory (Hard Version) | F2 | 2800 | ❌ |
| 2129 | Codeforces Round 1040 (Div. 1) | C1+C2+C3 | 1900 / 2000 / 2300 | Interactive RBS (Easy Version) + Interactive RBS (Medium Version) + Interactive RBS (Hard Version) | C3 | 2300 | ❌ |
| 2129 | Codeforces Round 1040 (Div. 1) | F1+F2 | 3500 / 3500 | Top-K Tracker (Easy Version) + Top-K Tracker (Hard Version) | F2 | 3500 | ✅ |
| 2219 | Codeforces Round 1093 (Div. 1) | B1+B2 | 1900 / 2000 | Unique Values (Easy version) + Unique Values (Hard version) | B2 | 2000 | ❌ |
| 1920 | Codeforces Round 919 (Div. 2) | F1+F2 | 2500 / 3000 | Smooth Sailing (Easy Version) + Smooth Sailing (Hard Version) | F2 | 3000 | ❌ |
| 1930 | think-cell Round 1 | D1+D2 | 1800 / 2100 | Sum over all Substrings (Easy Version) + Sum over all Substrings (Hard Version) | D2 | 2100 | ❌ |
| 1987 | EPIC Institute of Technology Round Summer 2024 (Div. 1 + Div. 2) | F1+F2 | 2500 / 2600 | Interesting Problem (Easy Version) + Interesting Problem (Hard Version) | F2 | 2600 | ❌ |
| 1987 | EPIC Institute of Technology Round Summer 2024 (Div. 1 + Div. 2) | G1+G2 | 2900 / 3500 | Spinning Round (Easy Version) + Spinning Round (Hard Version) | G2 | 3500 | ❌ |
| 2154 | Codeforces Round 1060 (Div. 2) | C1+C2 | 1400 / 2000 | No Cost Too Great (Easy Version) + No Cost Too Great (Hard Version) | C2 | 2000 | ❌ |
| 2154 | Codeforces Round 1060 (Div. 2) | F1+F2 | 2700 / 3300 | Bombing (Easy Version) + Bombing (Hard Version) | F2 | 3300 | ❌ |
| 2196 | Codeforces Round 1079 (Div. 1) | C1+C2 | 1800 / 2000 | Interactive Graph (Simple Version) + Interactive Graph (Hard Version) | C2 | 2000 | ❌ |
| 2196 | Codeforces Round 1079 (Div. 1) | E1+E2 | 2900 / 3000 | Fuzzy Concatenation (Easy Version) + Fuzzy Concatenation (Hard version) | E2 | 3000 | ❌ |
| 2194 | Codeforces Round 1078 (Div. 2) | F1+F2 | 2300 / 3000 | Again Trees... (Easy Version) + Again Trees... (hard version) | F2 | 3000 | ❌ |
| 2146 | Codeforces Round 1052 (Div. 2) | D1+D2 | 1500 / 2000 | Max Sum OR (Easy Version) + Max Sum OR (Hard Version) | D2 | 2000 | ❌ |
| 2257 | Codeforces Round 1117 (Div. 2) | F1+F2 | 2500 / 2700 | Beaver's Jumping Track (Easy Version) + Beaver's Jumping Track (Hard Version) | F2 | 2700 | ❌ |

## 表 1b · 两子任务的 rating 落差

- 落差的中位是 **+400** 分，最小 100、最大 800。
- 落差**恒为正**（第二个子任务定数总是更高），说明这不是「同一道题的两种限制」，
  而是**两道难度不同的题被编成了同一个题位**。

## 表 2 · 子任务个数分布

| 子任务个数 | 题位数 |
|---:|---:|
| 2 | 37 |
| 3 | 1 |

## 结论

- ⚠️ **有 36 个题位的子任务 rating 不一致**，取最后一个会改变该题位定数：

| contestId | 题位 | 各子任务 rating |
|---:|---|---|
| 2127 | G1+G2 | 3400 / 3500 |
| 1980 | F1+F2 | 1900 / 2400 |
| 2039 | C1+C2 | 1200 / 1800 |
| 2039 | F1+F2 | 2800 / 3200 |
| 1956 | E1+E2 | 2500 / 2700 |
| 1972 | D1+D2 | 1400 / 2200 |
| 2180 | F1+F2 | 2800 / 3200 |
| 2180 | H1+H2 | 3400 / 3500 |
| 2164 | F1+F2 | 2600 / 2900 |
| 2118 | D1+D2 | 1700 / 2200 |
| 2156 | F1+F2 | 2200 / 3000 |
| 2002 | D1+D2 | 1900 / 2300 |
| 2002 | F1+F2 | 2600 / 2800 |
| 2071 | D1+D2 | 1800 / 2500 |
| 2124 | F1+F2 | 2300 / 2800 |
| 2085 | F1+F2 | 2600 / 2900 |
| 2254 | C1+C2 | 1000 / 1200 |
| 2106 | G1+G2 | 2200 / 2500 |
| 2229 | C1+C2 | 900 / 1400 |
| 2163 | D1+D2 | 2100 / 2500 |
| 2189 | C1+C2 | 1300 / 1800 |
| 2189 | D1+D2 | 1900 / 2200 |
| 1919 | F1+F2 | 2300 / 2800 |
| 2129 | C1+C2+C3 | 1900 / 2000 / 2300 |
| 2219 | B1+B2 | 1900 / 2000 |
| 1920 | F1+F2 | 2500 / 3000 |
| 1930 | D1+D2 | 1800 / 2100 |
| 1987 | F1+F2 | 2500 / 2600 |
| 1987 | G1+G2 | 2900 / 3500 |
| 2154 | C1+C2 | 1400 / 2000 |
| 2154 | F1+F2 | 2700 / 3300 |
| 2196 | C1+C2 | 1800 / 2000 |
| 2196 | E1+E2 | 2900 / 3000 |
| 2194 | F1+F2 | 2300 / 3000 |
| 2146 | D1+D2 | 1500 / 2000 |
| 2257 | F1+F2 | 2500 / 2700 |
