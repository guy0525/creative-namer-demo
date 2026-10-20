# 创意洞察 · Creative Insights

广告素材的命名规范、AI 命名、短名称解码，以及投放数据回流后的多视角创意洞察分析。

上传识别固定产出两份结果：① **EFD-7 内容理解**（效果漏斗拆解：注意力→认同→叙事→信任→视听→台词→可复刻变量）；② **素材命名**（基于理解 + 知识库）。方法论全文见 [`methodology-efd7.md`](methodology-efd7.md)（Pages 演示站同步为 [`docs/methodology-efd7.md`](docs/methodology-efd7.md)）。

- **素材成效及标签分析**：按素材与命名标签拆解投放成效，给出素材生产建议
- **商品（SPU）分析**：热卖 / 爆款 / 衰退 / 新品识别，爆品素材共性、单品宣传方向 Brief
- **落地页分析**：转化漏斗掉点诊断（含 3 秒完播率），创意 × 落地页投放配方

## 在线演示

`docs/` 是用演示数据导出的静态只读版本，可直接用 GitHub Pages 发布（Settings → Pages → Branch: `main` / `docs`）。

## 本地运行

只依赖 Python 3.9+ 标准库：

```bash
python3 server.py          # 打开 http://127.0.0.1:8818
```

在「③ 数据分析」点「生成演示数据」即可体验。`READONLY=1 python3 server.py` 以只读模式启动。

## 重新导出演示站

```bash
python3 export_demo.py     # 用全新演示库生成 docs/，不会包含 data/ 下的真实数据
```
