---
title: 超宽表格横向拟合
book: 回归夹具
---

## 集群规划（真实案例：五列长 code 片）

行内 code 在主题里 nowrap 整片，五列长片叠起来 min-content 超版心：引擎应缩字号拟合页宽，不许把右侧整列裁掉。

|         | ZooKeeper | HDFS                                      | YARN                             | HBase                            |
| ------- | --------- | ----------------------------------------- | -------------------------------- | -------------------------------- |
| `node1` | `yes`     | `NameNode`,`DataNode`,`SecondaryNameNode` | `ResourceManager`, `NodeManager` | `HMaster`, `RegionServer`        |
| `node2` | `yes`     | `DataNode`                                | `NodeManager`                    | `HMaster(backup)`,`RegionServer` |
| `node3` | `yes`     | `DataNode`                                | `NodeManager`                    | `RegionServer`                   |

## 参数表（放得下的窄表不许动）

拟合只许命中真正超宽的表：这张两列参数表必须保持主题缺省字号 36px。

| 参数                   | 含义         |
| ---------------------- | ------------ |
| `--showHeader=boolean` | 是否渲染表头 |
| `--columns=number`     | 列数         |

## 极端表（缩到触底也放不下）

六个 24 字符 nowrap 片：字号下限 20px 仍超版心——引擎应保留已缩字号、按诚实溢出打红标交还作者。

| 列一 | 列二 | 列三 | 列四 | 列五 | 列六 |
| ---- | ---- | ---- | ---- | ---- | ---- |
| `aaaaaaaaaaaaaaaaaaaaaaaa` | `bbbbbbbbbbbbbbbbbbbbbbbb` | `cccccccccccccccccccccccc` | `dddddddddddddddddddddddd` | `eeeeeeeeeeeeeeeeeeeeeeee` | `ffffffffffffffffffffffff` |
