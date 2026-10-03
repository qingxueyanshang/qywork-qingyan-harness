# PPT（pptx）做法要点

## 流程

1. 有原文件先 `read_office`：拿到每页的形状、位置尺寸、文字、图表、表格和 `sha256`。
2. 用 `write_file` 写 Python 制作脚本。
3. `write_office` 执行：脚本写出工作副本 → 结构检查 → 逐页渲染 → 提交。pptx 不做后处理。
4. `view_office` 看页：每页都要看；文字密集或有小字的区域用 `region` 取局部。
5. 看出问题就改脚本再 `write`，改完重看改动的页。

生成成功、检查项为零都不等于合格：溢出、遮挡、配色和版式要看页面判断。

## 脚本 API

全局变量 `office`（也可 `from qyoffice import office`）：`office.output(路径)` 取工作副本路径；`office.inputs`；`office.workspace`；`office.figure(宽cm, 高cm)` 按最终尺寸出图；`office.app("pptx")` 取产品新起的 WPS 演示 / PowerPoint 原生对象（每次调用新起一个实例，一个实例只打开一个文件），不要用它另存文件。

python-pptx、lxml、Pillow 的完整 API 都可以用，也可以直接改 OOXML。

## 页面与字体

- 16:9 页面：`prs.slide_width = Inches(13.333)`、`prs.slide_height = Inches(7.5)`。
- python-pptx 的 `font.name` 只设西文字体，中文要另设 `a:ea`：

```python
from pptx.oxml.ns import qn

def set_fonts(run, latin, east_asia):
    """先设西文字体生成 a:latin，再在它后面放 a:ea（两者在 rPr 里的先后顺序是固定的）。"""
    run.font.name = latin
    latin_el = run._r.get_or_add_rPr().find(qn("a:latin"))
    ea = latin_el.getnext()
    if ea is None or ea.tag != qn("a:ea"):
        ea = latin_el.makeelement(qn("a:ea"), {})
        latin_el.addnext(ea)
    ea.set("typeface", east_asia)
```

- 不要依赖自动缩字：文本框按内容留足宽高，渲染后看有没有溢出或被裁掉。

## 原生对象

- 需要改数据的图表用原生图表（`slide.shapes.add_chart` + `CategoryChartData`），不要贴图；表格用 `add_table`。
- 只有照片、纹理这类无法用原生对象表达的内容才用图片。
- 图表里的字按最终显示尺寸设字号；数据标签与图例不要互相压住。
- 图表的坐标轴、刻度、图例文字默认是深灰色：深色背景上要显式设成浅色（`chart.font.color.rgb`，或逐个设 `category_axis.tick_labels.font`），看页时用 `region` 放大图表核对。

## 检查项

- `off_slide`：形状超出页面。
- `text_overlap`：两个文本框重叠，只是疑似遮挡；有意叠放（文字压在色块上）属于正常，要看页面判断。
- `empty_placeholder`：空占位符，放映时不显示，但编辑时会看到提示文字。
- `text_overflow`：按字号与字数估算，文字高度超出文本框两成以上；只是疑似，看页面确认。关了自动调整的文本框才估算。
- `east_asia_font_missing`：中文文字没有设东亚字体，主题次要字体里也没有。
- `notes_present` / `comments_present`：有演讲者备注或批注；用户没要求时，交付前清掉。
- `library_metadata`：文档属性是生成库的默认值。

## 图片型 PPT 重建成可编辑

1. `read` 看原稿每页的结构；原稿的图片在包里的 `ppt/media/`，脚本可以用 `zipfile` 取出。
2. 先按原图记下标题栏、Logo、卡片、图片框等固定区域的坐标，重建时以它为准。
3. 逐页列出原图上所有可见文字，包括叠在照片上的数据面板、标签、角标与水印。照片保留为图片时，这些文字仍要重建成文本框，不算照片的一部分。
4. 需要清掉底图上的文字时，用 `generate_image` 带原图改图（没有遮罩参数，改完要核对固定区域有没有变形、有没有多出的文字或图案；清掉的面板与标签要在上一步的清单里）。
5. 文字、图标、表格、数据图按原坐标用原生对象重建；看不清的内容标为待核对，不猜。
6. 交付前 `read` 新文件，与第 3 步的清单逐条对照，缺的补上。
7. 可编辑性要实测：再写一个脚本把副本里的文字、颜色、图表数据改掉，`write` 到另一个路径并 `view`，确认改动生效、没有双影。

## 修改已有文件

- 先 `read`：之后 `write` 同一路径时，工具以读到的版本为准，文件在此期间被别处改过就返回冲突、不覆盖。工作副本里已经是原文件的内容，只改需要改的形状。
- 交付件就是脚本写出的文件，工具不会让办公软件另存它。
- 文档属性由脚本设成真实作者：python-pptx 默认会写入最后修改者 `Steve Canny` 与备注 `generated using python-pptx`（检查项 `library_metadata`）。用户没有给作者时清空这些字段，不要写入工具名。（`prs.core_properties.last_modified_by`、`comments`）；主题名同样不要用工具名。

## 边界

- 带宏的文件（.pptm 等）一律拒绝打开。
- 渲染需要 Windows 上的 WPS 或 Microsoft Office；没有时渲染阶段返回 unavailable，不能当成看过页面。
- 技能里写的其他产品的执行方式（artifact-tool、soffice、shell 导出脚本等）只当做法参考，执行一律用 write_office；技能附带的专属代码要改写成这里支持的 Python。

## 最小示例

```python
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches, Pt

prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
slide = prs.slides.add_slide(prs.slide_layouts[6])
box = slide.shapes.add_textbox(Inches(0.6), Inches(0.4), Inches(12), Inches(1))
run = box.text_frame.paragraphs[0].add_run()
run.text = "季度收入"
run.font.size = Pt(32)
data = CategoryChartData()
data.categories = ["一季度", "二季度", "三季度"]
data.add_series("收入（万元）", (120, 150, 170))
slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(0.6), Inches(1.6),
                       Inches(12), Inches(5.4), data)
prs.save(office.output("汇报.pptx"))
```
