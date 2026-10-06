# 外部客户端使用利润计算

New API 金融页的利润计算原本在浏览器本地完成，不是数据库报表接口。现在外部应用可直接复用 `sdk/oauth-client/profit.mjs`，它由金融页原始算法去除 TypeScript 类型生成，计算、参数校验、日期、舍入和 CSV 输出均与页面一致。

这项能力不需要 OAuth 令牌，也不会发送网络请求、读取账户、变更真实余额、账单或利润报表。需要读取真实财务报表时，请调用相应的 OAuth 授权业务接口；本模块只根据给定参数计算。

## 快速使用

```js
import {
  calculateProfit,
  validateProfitInput,
  profitToCsv,
  PROFIT_LIMITS,
} from './sdk/oauth-client/profit.mjs';

const input = {
  startDate: '2026-10-02',
  days: 3,
  baseDailyRevenue: 100,
  marginMin: -20,
  marginMax: 60,
  revenueVolatility: 25,
  mode: 'random',
  seed: 42,
};

const result = calculateProfit(input);
if (!result.success) {
  console.error(result.errors); // 按字段返回校验信息；请在界面中本地化。
} else {
  console.log(result.data.days); // 每日明细
  console.log(result.data.summary.totalProfit); // 66.4 USD
  const csv = profitToCsv(result.data);
  // 浏览器可通过 Blob 下载；Node 可写入文件。
}
```

`profit.mjs` 是零依赖 ES 模块，浏览器和支持 ES 模块的 Node.js 均可使用。这里的导入路径应按应用文件的位置调整。生成及一致性测试工具使用 Node.js 22.13 或更高版本的内置 TypeScript 去类型功能；测试验证环境为 Node.js 24.21.0。

## 输入参数

全部字段必填，数字字段须传 JavaScript `number`，不要传数字字符串。传入一个符合下表结构的对象；`null` 等非对象不是接口支持的输入。

| 字段 | 含义 | 范围与规则 |
| --- | --- | --- |
| `startDate` | 第一日的日历日期 | 严格 `YYYY-MM-DD`，有效年份 `0001` 至 `9999`，最后一天不得晚于 `9999-12-31` |
| `days` | 天数，包括起始日 | 整数，`1` 至 `3650` |
| `baseDailyRevenue` | 基准日收入，美元 | 有限数字，`0` 至 `1,000,000,000` |
| `marginMin` | 毛利率下限，百分数 | 有限数字，`-100` 至 `100` |
| `marginMax` | 毛利率上限，百分数 | 有限数字，`-100` 至 `100`，不得低于 `marginMin` |
| `revenueVolatility` | 日收入围绕基准收入上下波动的百分比 | 有限数字，`0` 至 `100` |
| `mode` | 毛利率变化方式 | `stable`、`random` 或 `cycle` |
| `seed` | 可复现的随机种子 | 整数，`0` 至 `4,294,967,295`，`0` 是有效种子 |

百分比直接传 `20` 表示 `20%`。毛利率定义为 `(收入 − 成本) / 收入 × 100%`，不是成本加价率。负毛利率表示亏损；`100%` 毛利率表示成本为零。每日收入波动独立于毛利率模式：例如基准收入 `100`、波动 `25` 对应舍入前的收入范围 `75` 至 `125`。基准收入上限限制的是输入，每日收入在 `100%` 波动时可以达到基准值的两倍。

三种模式的行为：

- `stable`：从区间中点出发，每日向中点回归 `25%`，加上不超过区间跨度 `10%` 的正负扰动；不是固定毛利率。上下限设为同一数值可得到固定毛利率。
- `random`：每日从毛利率上下限之间取伪随机值。
- `cycle`：使用 `28` 天周期的正弦变化，随机种子决定初始相位。

毛利率先保留四位小数，再限制在输入区间内。种子使用原算法的 Mulberry32 生成器，三个模式都保留原页面的随机数消费顺序；同一组完整输入可以重复得到完全一致的结果，不受系统时间、其他调用或 `Math.random()` 影响。

日期按照 UTC 日历推进，输入和输出不包含时刻或时区，不会因夏令时或服务器本地时区增加、遗漏一天。

## 导出接口与输出

| 接口 | 返回值 |
| --- | --- |
| `calculateProfit(input)` | 校验通过时返回 `{ success: true, data: { days, summary } }`；失败时返回 `{ success: false, errors }`，没有 `data` 或部分生成的明细 |
| `validateProfitInput(input)` | 按输入字段名返回错误信息对象；有效输入返回 `{}` |
| `profitToCsv(data)` | 接受成功结果中的 `data`，返回 CSV 字符串 |
| `PROFIT_LIMITS` | 当前参数上限和下限常量，请只读使用 |

原页面导出名 `simulateProfit`、`validateSimulationInput`、`simulationToCsv`、`SIMULATION_LIMITS` 也保留，它们与以上接口分别引用同一个实现。外部界面可以使用“利润计算”等文案，无需展示内部源文件或导出名。

每日 `days` 元素包含：

| 字段 | 含义 |
| --- | --- |
| `date` | 当日日期，`YYYY-MM-DD` |
| `revenue` | 当日收入，美元，精确到分 |
| `cost` | 当日成本，美元，精确到分 |
| `profit` | 当日毛利润，美元，精确到分，可为负数 |
| `margin` | 当日设定毛利率，百分数，四位小数；金额舍入后反算的百分比可能略有不同 |
| `cumulativeProfit` | 截至当日的累计毛利润，美元 |

`summary` 包含：

| 字段 | 含义 |
| --- | --- |
| `totalRevenue`、`totalCost`、`totalProfit` | 总收入、总成本、总毛利润，美元 |
| `averageDailyRevenue`、`averageDailyProfit` | 日均收入、日均毛利润，美元，舍入到分 |
| `averageMargin` | 按收入加权的总体毛利率：总毛利润 / 总收入 × 100；收入为零时为 `0` |
| `minDailyProfit`、`maxDailyProfit` | 最低、最高单日毛利润，美元 |
| `profitableDays`、`lossDays` | 毛利润大于零、低于零的天数；零利润日不计入两者 |

计算过程先将收入与利润舍入为整数分，成本由收入减利润得到，累计也使用整数分。半分使用对称舍入，例如 `1.005` 美元收入变为 `1.01` 美元，`-0.005` 美元利润变为 `-0.01` 美元。输入上限确保整个期限的累计金额仍在 JavaScript 安全整数分范围内。若客户端继续对金额计算，宜转换为整数分，避免二进制浮点显示误差。

CSV 包含 UTF-8 BOM、CRLF 换行和明确的 USD 列头，金额两位小数、毛利率四位小数。日期文本会转义双引号并防止电子表格公式注入。请传入本模块的成功计算结果，不要把 CSV 导出函数当作任意不可信对象的通用校验器。

## 与金融页保持一致

唯一算法来源是 `web/src/features/finance/lib/profit-simulation.ts`。生成文件保留 New API / QuantumNous 原许可证说明，并记录源文件 SHA-256；请不要手工修改生成文件中的算法。

在仓库根目录运行：

```sh
node sdk/oauth-client/scripts/update-profit.mjs
node sdk/oauth-client/scripts/update-profit.mjs --check
node --test sdk/oauth-client/test/profit.test.mjs
```

第一条重新生成文件，第二条检测生成结果是否过期，第三条直接加载当前金融页源算法，验证三种模式、固定种子、跨闰年/世纪日期、金额边界、负利润及 CSV 的输出一致性。测试使用本地固定输入，不访问真实账户或上游模型。

本模块沿用项目 GNU AGPL v3 或更高版本许可证及商业授权信息。外部使用应保留对应版权和许可证说明；完整许可文本见仓库 `LICENSE`。
