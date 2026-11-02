---
headingDivider: 3
paginate: true
theme: lecture
title: 切分路径回归
---

`examples/demo.md` 每一节都装得下一页，物理分页只需要"在单元边界上搬整块"，
按行 / 按项切的那几条分支一条都走不到。这份 fixture 反过来：每一节的块都刻意长过一页，
逼 `overflow.js` 真的去切。

覆盖的分支：代码块按行切、表格按行切（续页带表头）、列表按项切（`<ol>` 续页接着编号）、
以及单个列表项就高过整页时切进项内部。

## 超长代码块

代码块按行切开时，`<pre>` 里的高亮 span 会被切没，所以收敛之后必须补染一次。

```python
def build_fact_order(spark, dt):
    """事务事实表：一行一次下单事件，粒度是订单明细。"""
    src = spark.table("ods.ods_order_di").filter(F.col("dt") == dt)
    dim_user = spark.table("dim.dim_user").filter(F.col("dt") == dt)
    dim_sku = spark.table("dim.dim_sku").filter(F.col("dt") == dt)

    joined = (
        src.alias("o")
        .join(dim_user.alias("u"), F.col("o.user_id") == F.col("u.user_id"), "left")
        .join(dim_sku.alias("s"), F.col("o.sku_id") == F.col("s.sku_id"), "left")
    )

    fact = joined.select(
        F.col("o.order_id").alias("order_id"),
        F.col("o.user_id").alias("user_id"),
        F.col("o.sku_id").alias("sku_id"),
        F.col("u.city_code").alias("city_code"),
        F.col("s.cate_code").alias("cate_code"),
        F.col("o.pay_amount").alias("order_amount"),
        F.col("o.pay_amount").alias("pay_amount"),
        F.col("o.discount_amount").alias("discount_amount"),
        F.col("o.create_time").alias("order_time"),
    )

    # 可加度量：金额可以跨任意维度累加
    agg = fact.groupBy("city_code", "cate_code").agg(
        F.sum("order_amount").alias("total_amount"),
        F.countDistinct("order_id").alias("order_cnt"),
        F.countDistinct("user_id").alias("user_cnt"),
    )

    agg = agg.withColumn("dt", F.lit(dt)).withColumn("etl_time", F.current_timestamp())

    (
        agg.write.mode("overwrite")
        .format("orc")
        .partitionBy("dt")
        .saveAsTable("dwd.fact_order_di")
    )

    return agg.count()
```

## 超长表格

表格按行切之后，续页拿到的必须是一张**带表头的完整表**，而不是一堆裸行——
否则翻到第二页就不知道每列是什么了。

| 层 | 表名 | 粒度 | 分区 | 更新方式 | 负责人 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| ODS | ods_order_di | 订单明细 | dt | 每日全量 | 张伟 | 保留 30 天 |
| ODS | ods_pay_di | 支付流水 | dt | 每日全量 | 张伟 | 保留 30 天 |
| ODS | ods_refund_di | 退款流水 | dt | 每日全量 | 李娜 | 保留 30 天 |
| ODS | ods_cart_di | 加购明细 | dt | 每日增量 | 李娜 | 保留 7 天 |
| ODS | ods_click_di | 点击日志 | dt, hh | 每小时增量 | 王强 | 保留 7 天 |
| ODS | ods_expose_di | 曝光日志 | dt, hh | 每小时增量 | 王强 | 保留 7 天 |
| DWD | fact_order_di | 订单明细 | dt | 每日覆盖 | 张伟 | 事务事实表 |
| DWD | fact_pay_di | 支付明细 | dt | 每日覆盖 | 张伟 | 事务事实表 |
| DWD | fact_refund_di | 退款明细 | dt | 每日覆盖 | 李娜 | 事务事实表 |
| DWD | fact_cart_snapshot | 加购快照 | dt | 每日快照 | 李娜 | 周期快照 |
| DWD | fact_stock_snapshot | 库存快照 | dt | 每日快照 | 王强 | 周期快照 |
| DWD | fact_user_snapshot | 账户余额 | dt | 每日快照 | 王强 | 半可加 |
| DWD | fact_order_fulfil | 订单履约 | dt | 每日更新 | 赵敏 | 累积快照 |
| DWD | fact_ads_cost | 广告消耗 | dt | 每日覆盖 | 赵敏 | 事务事实表 |
| DWD | fact_coupon_use | 券核销 | dt | 每日覆盖 | 孙悦 | 事务事实表 |
| DWD | fact_live_watch | 直播观看 | dt | 每日覆盖 | 孙悦 | 半可加 |
| DWD | fact_search_di | 搜索词 | dt | 每日覆盖 | 周涛 | 事务事实表 |
| DWS | dws_trade_1d | 交易日汇总 | dt | 每日覆盖 | 张伟 | 可加 |
| DWS | dws_trade_7d | 交易 7 日 | dt | 每日覆盖 | 张伟 | 半可加 |
| DWS | dws_trade_30d | 交易 30 日 | dt | 每日覆盖 | 张伟 | 半可加 |
| DWS | dws_user_1d | 用户日汇总 | dt | 每日覆盖 | 李娜 | 可加 |
| DWS | dws_sku_1d | 商品日汇总 | dt | 每日覆盖 | 李娜 | 可加 |
| DWS | dws_shop_1d | 店铺日汇总 | dt | 每日覆盖 | 王强 | 可加 |
| DWS | dws_city_1d | 城市日汇总 | dt | 每日覆盖 | 王强 | 可加 |
| DWS | dws_cate_1d | 类目日汇总 | dt | 每日覆盖 | 赵敏 | 可加 |
| ADS | ads_trade_overview | 大盘 | dt | 每日覆盖 | 赵敏 | 报表直出 |
| ADS | ads_user_retention | 留存 | dt | 每日覆盖 | 孙悦 | 报表直出 |
| ADS | ads_sku_rank | 商品榜 | dt | 每日覆盖 | 孙悦 | 报表直出 |
| ADS | ads_shop_rank | 店铺榜 | dt | 每日覆盖 | 周涛 | 报表直出 |
| ADS | ads_realtime_board | 实时看板 | 无 | 流式写入 | 周涛 | 不落分区 |

## 超长无序列表

列表按项切。切点落在项边界上，项自己不会被拆开。

- 先确认上游表当天分区已经就绪，缺分区要等补数，不能直接跑
- 检查分区行数是否落在昨日 ±20% 的区间内，超出先找上游
- 主键唯一性校验：订单明细表 `order_id` 必须唯一
- 金额非空校验：`pay_amount` 为空的比例不得超过 0.1%
- 维度退化校验：`city_code` / `cate_code` 的空值率单独统计
- 时间字段校验：`order_time` 必须落在当天区间内
- 枚举值校验：订单状态只允许出现已定义的那几个取值
- 与昨日快照对比：新增、消失、变更的订单数分别统计
- 重复运行校验：同一份 SQL 连跑两次结果必须一致
- 空分区校验：结果表当天分区行数不得为 0
- 数据倾斜校验：单个 reducer 的耗时不得超过均值 3 倍
- 小文件校验：输出文件平均大小不得低于 128 MB
- 权限校验：结果表的读权限已经授予下游应用账号
- 元数据校验：字段注释、表注释齐全，否则下游看不懂
- 生命周期校验：临时表设置了回收时间，不能一直占着
- 成本校验：本次运行的花费不得超过预算上限
- 依赖校验：下游任务的最早开始时间晚于本任务预计结束时间
- 告警校验：任务失败时告警能到达值班人
- 回滚校验：保留上一版本数据，出问题时能切回去
- 文档校验：口径变更已同步更新到指标平台
- 灰度校验：涉及口径调整时先在灰度环境跑一遍
- 回归校验：口径调整后历史数据要重跑并对比差异
- 验收校验：结果由需求方确认无误后才允许上线
- 归档校验：上线后把本次的 SQL 与结果快照归档留存

## 超长有序列表

有序列表除了按项切，续页还得接着编号——第二页不能又从 1 开始。

1. 拉取 ODS 层当天分区，确认数据就绪
2. 清洗异常值：金额为负、时间越界的记录单独落异常表
3. 与维表关联，退化常用维度字段到事实表
4. 生成代理键，保证事实表与维表可关联
5. 计算可加度量：金额、件数
6. 计算派生度量：客单价、件单价
7. 写入 DWD 层事务事实表
8. 校验主键唯一性
9. 校验分区行数波动
10. 写入 DWS 层日汇总表
11. 计算 7 日 / 30 日滚动指标
12. 半可加度量单独标记，避免跨时间累加
13. 生成 ADS 层报表结果表
14. 刷新 BI 数据集缓存
15. 推送指标变更通知
16. 归档本次运行日志
17. 更新数据血缘
18. 更新任务调度依赖
19. 释放临时资源
20. 标记任务完成并发送值班通知

## 列表项里嵌长代码块

单个列表项就高过一整页时，项边界上切不动——切了也是溢出。
这种时候只能切进项的内部：它头部留下，尾部连着后面的项一起去下一页。

前面先垫两段正文，把这一页的剩余空间压到不足一页，确保第一个列表项放不进去。
这一段只是占位，目的是让 `splitList` 走到 `cut <= 0` 那条分支上去。
再补一句，把空间压得更低一些，这样第一个列表项里的代码块必然要被切开。

- 第一步：建外部表并挂载当天分区，语句如下

  ```sql
  CREATE EXTERNAL TABLE IF NOT EXISTS ods.ods_order_di (
      order_id          STRING  COMMENT '订单号',
      user_id           STRING  COMMENT '用户号',
      sku_id            STRING  COMMENT '商品号',
      pay_amount        DECIMAL(18, 2) COMMENT '支付金额',
      discount_amount   DECIMAL(18, 2) COMMENT '优惠金额',
      order_status      STRING  COMMENT '订单状态',
      create_time       STRING  COMMENT '创建时间',
      update_time       STRING  COMMENT '更新时间'
  )
  COMMENT '订单明细，每日全量'
  PARTITIONED BY (dt STRING COMMENT '分区日期')
  STORED AS ORC
  LOCATION '/warehouse/ods/ods_order_di/';

  ALTER TABLE ods.ods_order_di
  ADD IF NOT EXISTS PARTITION (dt = '2026-10-18')
  LOCATION '/warehouse/ods/ods_order_di/dt=2026-10-18/';
  ```

- 第二步：校验分区行数是否落在合理区间
- 第三步：确认无误后交给下游的 DWD 任务
