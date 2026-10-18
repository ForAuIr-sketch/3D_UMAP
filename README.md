# 3D UMAP — skin aging expression atlas

本版本沿用原项目 Three.js 3D UMAP、密度表面、细胞标签、旋转缩放、深/黑/白背景和高清导出，扩充用于论文和审稿交流的数据查询功能。

- **68,646 cells；37 个原始 metadata 字段；434 个基因。**
- 表达量来自 `scRNA_merged_3DUMAP.rds` 的 `RNA` assay / `data` layer，未重新归一化或替换为 integrated / scale.data。
- 所有细胞以 `cell_id` 精确对齐；原 UMAP CSV 已与 RDS 的 `umap3d` embedding 逐项核对。
- 细胞原注释、坐标和顺序保留。基因按需加载，每个 Float32 文件约 275 KB，缓存最多 12 个基因。
- 数据目录含 283 个原网页 ECM panel 基因，并加入各类细胞及其他常用 marker；重叠基因只存储一次。精确数量以 manifest 为准。

## 打开

Mac：双击 `打开3D_UMAP.command`，保持终端窗口开启。需要 Python 3。若系统没有直接执行脚本，可在该文件夹中运行：

```sh
python3 tools/serve.py
```

也可通过任意静态 HTTP 服务发布整个文件夹。不能只双击 index.html：浏览器的本地文件限制会阻止数据加载。Three.js 已随文件附带，运行时不依赖外部 CDN。

本交付物是本地版，没有更新现有 GitHub Pages。要分享审稿链接，应将本版本整套文件放到期刊允许的静态网站或数据仓库，并确定 metadata 的分享范围。

## 操作

1. `Color by → Gene expression`：输入完整基因符号后 Apply，支持大小写不敏感匹配和自动补全。例如 CD3D、PECAM1；“CD”是前缀，不能作为完整基因名。
2. `Marker / ECM panel`：按细胞类型、ECM、衰老/增殖等分组快速选基因。分组是查询列表，不代表重新注释，也不保证每个 marker 都具有唯一细胞特异性。
3. `Color by → Metadata`：37 个原字段均可查看和着色。数值字段用连续色标；分类字段用分类颜色和计数。缺失值保留为缺失并显示灰色，不会被当作零。
4. `Inspect a cell`：点击图中的点，展开其 cell_id、全部 metadata 和当前已加载基因表达量。拖动时不会触发单击选点。
5. `Continuous color scale`：默认按所选字段的全体细胞 2–98% 分位裁剪，可切换 Full data range。色标不是不同基因间的共同表达尺度；若稀疏基因的 2% 和 98% 分位相同，自动采用全范围并在色标说明中显示 full range，避免零宽色标。
6. `Export 2× / 4× PNG`：导出当前视图，基因/metadata 视图附所选字段名、色标及范围信息。实际分辨率取决于窗口大小及显卡限制，状态栏显示真实导出尺寸。
7. `Save view & data provenance`：导出相机、配色、显示范围、界面参数和数据来源 JSON。该文件用于记录参数，本版本未提供一键导入恢复。
8. `Dataset & downloads`：下载全部 metadata、基因目录、数据来源 JSON、当前基因的逐细胞表达 CSV。

查询也可写在 URL，例如：

```text
?colorby=gene&gene=PECAM1
?colorby=gene&gene=CCL21&scale=full
?colorby=metadata&field=age_group
```

## 数据来源与解释

- `data/metadata_all.csv`：RDS 的全部 37 个 metadata 列，另加行名 cell_id；字段 R 类型、分类水平和缺失计数记录在 manifest。
- `data/cells_metadata.csv`：metadata + 原 3D 坐标 + 旧网页的派生字段。
- 原网页 `Age_group`、`ECM_AUC`、`SenCID_score`、`SenCID_binary` 从原 `umap3d_multifeature.csv` 按 cell_id 保留；本次未重算，也未混同为 RDS metadata 中同名近似字段。原始 `age_group` 和六套 `SenCID_Score01–06` 等仍单独保留。
- `data/genes/*.f32`：对应 manifest 中基因名，按 cells_metadata.csv 顺序存储的 little-endian Float32。RNA/data 的原数值仅做 Float32 存储精度转换。
- `data/manifest.json`：基因清单、分组、数值范围、零表达数、文件 SHA256、metadata 字段信息和数据来源。
- `data/validation.json`：自动校验记录；浏览器另已实际切换验证 16 个用户指定基因和全部 37 个 metadata 字段，并完成 PNG 导出检查。

### 注释复核

原 “Mast cells” 群体共有 1,247 个细胞。原 RNA/data 中：TPSAB1、TPSB2、CPA3 的检出率分别约 1.20%、0.80%、0.40%，而 MLANA、DCT、TYR 分别约 92.86%、90.30%、84.36%；MITF 约 96.31%。此模式更支持黑色素细胞身份，需要回到聚类、QC 和多 marker 共表达进一步确认。此版本保留原 Mast cells 标签，并加入独立 Melanocytes 面板供核查，没有自动改名。KIT 单独阳性不能确认肥大细胞。

ACTA2/TAGLN/MYH11 是壁细胞/平滑肌相关标志，不能独立区分周细胞和血管平滑肌细胞；CLDN5/PECAM1 可在血管和淋巴管内皮间共享；CD14、CD68 等反映髓系亚群特征，不能用单基因代替整个髓系注释。此网页是表达探索和可视化工具，不进行差异检验或重新注释。

检出率证据表：`data/mast_identity_positive_percent.csv`；平均表达表：`data/mast_identity_mean.csv`。

## Marker 参考来源

- Ma et al., Nature Communications (2023), skin cell annotations and representative markers: https://www.nature.com/articles/s41467-023-39020-4
- Human skin vascular endothelial heterogeneity (2021), blood and lymphatic endothelial markers: https://pmc.ncbi.nlm.nih.gov/articles/PMC8120211/
- Sun-exposed / unexposed skin single-cell study (2024), pericyte and lymphatic markers: https://www.frontiersin.org/journals/medicine/articles/10.3389/fmed.2024.1453940/full
- Skin rosacea single-cell atlas (2024), melanocyte and other lineage markers: https://www.nature.com/articles/s41467-024-52946-7

## 再导出与校验

需要 R、Seurat、Matrix、jsonlite、digest。保留原网页目录中的两份 CSV 作为坐标和旧网页分值来源：

```sh
Rscript tools/export_review.R /path/scRNA_merged_3DUMAP.rds /path/original_3D_UMAP /path/output_viewer
node tools/test_data.mjs
node tools/test_review.mjs
```

`test_review` 核对全部 434 个基因文件的长度、SHA256、零表达数和有效数值、细胞 ID 唯一性、metadata 字段及缺失值处理。

## English reviewer note

This browser-based atlas displays 68,646 cells at their original 3D UMAP coordinates. It provides all 37 metadata fields from the Seurat object and 434 selected RNA genes, including the original ECM panel and canonical lineage markers. Expression is read from the Seurat RNA/data layer without re-normalization. Genes are loaded individually; color legends report the selected display range. PNG figures and view/provenance records can be exported. Original annotations are retained; the group originally labelled “Mast cells” requires review because its marker profile is strongly melanocytic. This viewer does not perform differential expression testing or re-annotation.
