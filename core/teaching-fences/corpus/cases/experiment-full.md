---
title: 实验 2：WordCount
course: BD101
chapter: "3"
---

<!--quiz id=wc-q1 answer=B point=3-->
MapReduce 的数据本地性指的是？

- A. 数据存在内存
- B. 计算靠近数据

<!--step id=wc-s1 name="编写 Mapper" point=7-->

按 mrjob 协议填写 map 方法体：

```java map
// 学生在此填写
```

```check-code path=.mdjob/src/WordCountMapper.java mode=loose
// 参考答案（学生版整块删除）
```

<!--step id=wc-s2 name="运行并验证输出" point=7-->

```csv file=data/input.txt
hello world
hello hadoop
```

```match-output run=hadoop stdin=data/input.txt
hadoop	1
hello	2
world	1
```

<!--check-file path=.mdjob/out/part-r-00000-->

<!--fill id=wc-r1 min=30-->
（学生在此书写实验结论，到下一个标题/指令为止）
