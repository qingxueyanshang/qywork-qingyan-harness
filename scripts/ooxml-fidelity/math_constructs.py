"""公式校准的构造文档：按组生成最小 docx（OMML 片段、文档默认字体 Times New Roman 与宋体、Cambria Math），只用于本地校准。

组与字号（`w:sz` 半磅；文档缺省字号与之相同，noctrl 组除外）：
- size：各构造一个公式，10.5、12、24、48、96 磅；
- sweep：显示与行内分数、上下标、求和、括号、根号、重音，8 至 72 磅共 20 个字号；
- spacing、accents、naries、fences、scripts、layout：按主题，12 与 24 磅；
- grow、misc：括号伸展、n 元运算符 grow、线性与无线分数，12、24、48 磅；
- lin：线性分数的斜线、间距与字号，10.5 至 48 磅共 6 个字号；
- nest：括号套括号、分母为分数时的括号伸展，12 与 24 磅；
- suph：上下标的行高与复合底式的移位，10.5、12、24 磅；
- wrap-*：超出版心的公式（显示与行内）的断行，各组的 `m:brkBin`、`m:brkBinSub`、`m:wrapIndent` 不同，12 与 24 磅；
- nor：普通文字字段与数学字体缺字的字符（Times New Roman、Arial、Calibri、宋体、黑体、微软雅黑）作首个字符与其后字符时的行高，
  10.5 至 24 磅；
- zones：同一段落中的多个 `m:oMath`（在与不在 `m:oMathPara` 中）之间的间距，10.5、12、24 磅；
- noctrl：文档缺省字号 10.5 磅、字段 11 至 24 磅时没有 `ctrlPr` 的结构（分数、求和、括号、上标、根号）；
- lim：上下极限与两侧原子的横向位置，12 与 24 磅；limits：两侧为各类原子与公式两端时，24 与 48 磅；
- radical：显示公式中根号的行高与纵向位置，24、48、72 磅；radsize：根号字号 10.5 磅、被开方式 12 至 25 磅时的变体选择；
- denom、cramp：分母、下标、重音、横线、n 元运算符下限与极限中的上标，以及括住分数的括号，12 至 48 磅；
- plain：`m:sty` 与字段字体（Times New Roman、Arial、Calibri、宋体）对绘制字体与行高的影响，24 磅；
- hint：东亚提示的普通文字与数学字段中各字符的绘制字体与行高，24 磅；boxes：`m:box` 的内容，12 与 24 磅。

用法：python math_constructs.py <输出目录> [组名...]（缺省为全部组）
"""

import re
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
NS = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"')
def mathpr(brk="before", sub="--", wrap='<m:wrapIndent m:val="1440"/>'):
    return (f'<m:mathPr><m:mathFont m:val="Cambria Math"/><m:brkBin m:val="{brk}"/><m:brkBinSub m:val="{sub}"/>'
            '<m:smallFrac m:val="0"/><m:dispDef/><m:lMargin m:val="0"/><m:rMargin m:val="0"/>'
            f'<m:defJc m:val="centerGroup"/>{wrap}<m:intLim m:val="subSup"/>'
            '<m:naryLim m:val="undOvr"/></m:mathPr>')


MATHPR = mathpr()


def wrpr(sz=None, font="Cambria Math"):
    s = f'<w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/>' if sz else ""
    return f'<w:rPr><w:rFonts w:ascii="{font}" w:hAnsi="{font}"/>{s}</w:rPr>'


class Ctx:
    """当前组的字号与字体：公式字段与结构的 w:rPr 按它写出。"""

    sz = None
    font = "Cambria Math"


def r(text, sty=None, scr=None, nor=False):
    mp = ""
    if sty or scr or nor:
        mp = "<m:rPr>" + (f'<m:scr m:val="{scr}"/>' if scr else "") + (f'<m:sty m:val="{sty}"/>' if sty else "") + \
             ("<m:nor/>" if nor else "") + "</m:rPr>"
    return f'<m:r>{mp}{wrpr(Ctx.sz, Ctx.font)}<m:t xml:space="preserve">{escape(text)}</m:t></m:r>'


def rt(text, sty=None):
    """普通文字字段（`m:nor`），Times New Roman 斜体，与语料中线性分数公式的字段写法相同。"""
    mp = "<m:rPr><m:nor/>" + (f'<m:sty m:val="{sty}"/>' if sty else "") + "</m:rPr>"
    s = f'<w:sz w:val="{Ctx.sz}"/><w:szCs w:val="{Ctx.sz}"/>' if Ctx.sz else ""
    i = "<w:i w:val=\"0\"/>" if sty == "p" else "<w:i/>"
    return (f'<m:r>{mp}<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/>{i}{s}</w:rPr>'
            f'<m:t xml:space="preserve">{escape(text)}</m:t></m:r>')


def ctrl():
    return f"<m:ctrlPr>{wrpr(Ctx.sz, Ctx.font)}</m:ctrlPr>"


def e(*xs):
    return "<m:e>" + "".join(xs) + "</m:e>"


def frac(num, den, typ=None):
    t = f'<m:type m:val="{typ}"/>' if typ else ""
    return f"<m:f><m:fPr>{t}{ctrl()}</m:fPr><m:num>{num}</m:num><m:den>{den}</m:den></m:f>"


def sup(base, s):
    return f"<m:sSup><m:sSupPr>{ctrl()}</m:sSupPr>{e(base)}<m:sup>{s}</m:sup></m:sSup>"


def sub(base, s):
    return f"<m:sSub><m:sSubPr>{ctrl()}</m:sSubPr>{e(base)}<m:sub>{s}</m:sub></m:sSub>"


def subsup(base, b, s):
    return f"<m:sSubSup><m:sSubSupPr>{ctrl()}</m:sSubSupPr>{e(base)}<m:sub>{b}</m:sub><m:sup>{s}</m:sup></m:sSubSup>"


def rad(x, deg=None):
    if deg is None:
        return f'<m:rad><m:radPr><m:degHide m:val="1"/>{ctrl()}</m:radPr><m:deg/>{e(x)}</m:rad>'
    return f"<m:rad><m:radPr>{ctrl()}</m:radPr><m:deg>{deg}</m:deg>{e(x)}</m:rad>"


def nary(ch, lo, hi, body, loc=None, grow=False):
    pr = f'<m:chr m:val="{ch}"/>' if ch else ""
    pr += f'<m:limLoc m:val="{loc}"/>' if loc else ""
    pr += '<m:grow m:val="1"/>' if grow else ""
    pr += '<m:subHide m:val="1"/>' if lo is None else ""
    pr += '<m:supHide m:val="1"/>' if hi is None else ""
    return (f"<m:nary><m:naryPr>{pr}{ctrl()}</m:naryPr><m:sub>{lo or ''}</m:sub><m:sup>{hi or ''}</m:sup>"
            f"{e(body)}</m:nary>")


def d(*items, beg=None, end=None, sep=None, grow=None):
    pr = ""
    pr += f'<m:begChr m:val="{beg}"/>' if beg is not None else ""
    pr += f'<m:sepChr m:val="{sep}"/>' if sep is not None else ""
    pr += f'<m:endChr m:val="{end}"/>' if end is not None else ""
    pr += f'<m:grow m:val="{grow}"/>' if grow is not None else ""
    return f"<m:d><m:dPr>{pr}{ctrl()}</m:dPr>" + "".join(e(x) for x in items) + "</m:d>"


def eqarr(*rows):
    return f"<m:eqArr><m:eqArrPr>{ctrl()}</m:eqArrPr>" + "".join(e(x) for x in rows) + "</m:eqArr>"


def func(name, body):
    return f"<m:func><m:funcPr>{ctrl()}</m:funcPr><m:fName>{name}</m:fName>{e(body)}</m:func>"


def acc(x, ch=None):
    pr = f'<m:chr m:val="{ch}"/>' if ch else ""
    return f"<m:acc><m:accPr>{pr}{ctrl()}</m:accPr>{e(x)}</m:acc>"


def bar(x, pos=None):
    pr = f'<m:pos m:val="{pos}"/>' if pos else ""
    return f"<m:bar><m:barPr>{pr}{ctrl()}</m:barPr>{e(x)}</m:bar>"


def box(x):
    return f"<m:box><m:boxPr>{ctrl()}</m:boxPr>{e(x)}</m:box>"


def limlow(x, lim):
    return f"<m:limLow><m:limLowPr>{ctrl()}</m:limLowPr>{e(x)}<m:lim>{lim}</m:lim></m:limLow>"


def limupp(x, lim):
    return f"<m:limUpp><m:limUppPr>{ctrl()}</m:limUppPr>{e(x)}<m:lim>{lim}</m:lim></m:limUpp>"


def groupchr(x, ch=None, pos=None):
    pr = (f'<m:chr m:val="{ch}"/>' if ch else "") + (f'<m:pos m:val="{pos}"/>' if pos else "")
    return f"<m:groupChr><m:groupChrPr>{pr}{ctrl()}</m:groupChrPr>{e(x)}</m:groupChr>"


def matrix(rows):
    cols = len(rows[0])
    pr = f'<m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val="{cols}"/><m:mcJc m:val="center"/></m:mcPr></m:mc></m:mcs>{ctrl()}</m:mPr>'
    return "<m:m>" + pr + "".join("<m:mr>" + "".join(e(c) for c in row) + "</m:mr>" for row in rows) + "</m:m>"


def omath(*xs):
    return "<m:oMath>" + "".join(xs) + "</m:oMath>"


def omathpara(*xs, jc=None):
    pr = f'<m:oMathParaPr><m:jc m:val="{jc}"/></m:oMathParaPr>' if jc else ""
    return "<m:oMathPara>" + pr + "".join(xs) + "</m:oMathPara>"


def text(t, sz=None, font=None):
    f = f'<w:rFonts w:ascii="{font}" w:hAnsi="{font}"/>' if font else ""
    s = f'<w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/>' if sz else ""
    rp = f"<w:rPr>{f}{s}</w:rPr>" if f or s else ""
    return f'<w:r>{rp}<w:t xml:space="preserve">{escape(t)}</w:t></w:r>'


def para(*xs, jc=None, after=None):
    ppr = ""
    if jc or after is not None:
        ppr = "<w:pPr>" + (f'<w:spacing w:after="{after}"/>' if after is not None else "") + \
              (f'<w:jc w:val="{jc}"/>' if jc else "") + "</w:pPr>"
    return "<w:p>" + ppr + "".join(xs) + "</w:p>"


def write_docx(path, paras, sz=24, mathpr=MATHPR, margins=(1440, 1440, 1440, 1440)):
    body = "".join(paras)
    top, right, bottom, left = margins
    sect = (f'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="{top}" w:right="{right}" '
            f'w:bottom="{bottom}" w:left="{left}" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>')
    doc = HEAD + f"<w:document {NS}><w:body>{body}{sect}</w:body></w:document>"
    styles = (HEAD + f"<w:styles {NS}><w:docDefaults><w:rPrDefault><w:rPr>"
              '<w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>'
              f'<w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault>'
              '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault>'
              '</w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/></w:style>'
              "</w:styles>")
    settings = (HEAD + f'<w:settings {NS}><w:defaultTabStop w:val="420"/>{mathpr}'
                '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>'
                "</w:settings>")
    ct = (HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
          '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
          '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
          "</Types>")
    rels = (HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            "</Relationships>")
    drels = (HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
             '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
             '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>'
             "</Relationships>")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", ct)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", doc)
        z.writestr("word/styles.xml", styles)
        z.writestr("word/settings.xml", settings)
        z.writestr("word/_rels/document.xml.rels", drels)


def size():
    return f'<w:sz w:val="{Ctx.sz}"/><w:szCs w:val="{Ctx.sz}"/>' if Ctx.sz else ""


def nr(t, ascii="Times New Roman", ea="宋体", hint=None, italic=False):
    """普通文字字段（`m:nor`、正体）：西文与东亚字体、`w:hint` 可指定。"""
    h = f' w:hint="{hint}"' if hint else ""
    i = "<w:i/>" if italic else '<w:i w:val="0"/>'
    return (f'<m:r><m:rPr><m:nor/><m:sty m:val="p"/></m:rPr><w:rPr><w:rFonts{h} w:ascii="{ascii}" w:hAnsi="{ascii}" '
            f'w:eastAsia="{ea}" w:cs="Times New Roman"/>{i}{size()}</w:rPr><m:t xml:space="preserve">{escape(t)}</m:t></m:r>')


def ea(t, font="宋体"):
    """东亚提示的普通文字字段。"""
    return nr(t, ea=font, hint="eastAsia")


def mr(t, font=None, extra=""):
    """数学字段（不是 `m:nor`）：`font` 为 None 时不写 `w:rFonts`。"""
    f = f'<w:rFonts w:ascii="{font}" w:hAnsi="{font}"/>' if font else ""
    return f'<m:r><w:rPr>{f}{size()}{extra}</w:rPr><m:t xml:space="preserve">{escape(t)}</m:t></m:r>'


def sub_ctrl(base, lo, font):
    """下标结构，`ctrlPr` 的字体为 `font`；None 为没有 `ctrlPr`。"""
    c = f'<m:ctrlPr><w:rPr><w:rFonts w:ascii="{font}" w:hAnsi="{font}"/>{size()}</w:rPr></m:ctrlPr>' if font else ""
    return f"<m:sSub><m:sSubPr>{c}</m:sSubPr>{e(base)}<m:sub>{lo}</m:sub></m:sSub>"


def noctrl(xml):
    """去掉各结构的 `ctrlPr`，字段的字号不变。"""
    return re.sub(r"<m:ctrlPr>.*?</m:ctrlPr>", "", xml)


def small(t):
    return text(t, sz=10)


def T(*xs):
    return para(text("文"), omath(*xs), text("文"))


def D(*xs, jc=None):
    return para(omathpara(omath(*xs), jc=jc))


def size_formulas():
    P = []
    P.append(para(text("文字"), omath(r("x+y=z")), text("文字")))
    P.append(para(text("文"), omath(r("a−b×c·d,e;f")), text("文")))
    P.append(para(text("文"), omath(sup(r("x"), r("2"))), text("文"), omath(sub(r("x"), r("i"))), text("文"),
                  omath(subsup(r("x"), r("i"), r("2"))), text("文")))
    P.append(para(text("文"), omath(subsup(r("x"), r("ij"), r("n+1"))), text("文"),
                  omath(sup(d(r("a+b")), r("2"))), text("文")))
    P.append(para(omathpara(omath(r("x="), frac(r("a"), r("b"))))))
    P.append(para(text("文"), omath(frac(r("a"), r("b"))), text("文"), omath(frac(r("1"), r("2"))), text("文")))
    P.append(para(omathpara(omath(frac(r("a+b"), r("c+d")), r("+"), frac(r("1"), r("2x"))))))
    P.append(para(omathpara(omath(frac(r("1"), r("1+") + frac(r("1"), r("x")))))))
    P.append(para(omathpara(omath(rad(r("x")), r("+"), rad(frac(r("a"), r("b")))))))
    P.append(para(text("文"), omath(rad(r("x"))), text("文"), omath(rad(r("b"))), text("文")))
    P.append(para(omathpara(omath(nary("∑", r("i=1"), r("n"), sub(r("x"), r("i")), loc="undOvr")))))
    P.append(para(text("文"), omath(nary("∑", r("i=1"), r("n"), sub(r("x"), r("i")), loc="undOvr")), text("文")))
    P.append(para(omathpara(omath(nary("∑", r("i=1"), r("n"), sub(r("x"), r("i")), loc="subSup")))))
    P.append(para(omathpara(omath(nary("∑", r("i"), None, sub(r("x"), r("i")), loc="undOvr")))))
    P.append(para(omathpara(omath(d(r("a+b")), r("+"), d(r("a"), beg="[", end="]"), r("+"),
                                  d(frac(r("a"), r("b"))), r("+"), d(r("x"), beg="|", end="|")))))
    P.append(para(text("文"), omath(d(r("x")), d(r("x"), beg="[", end="]"), d(r("x"), beg="{", end="}"),
                                   d(r("x"), beg="|", end="|")), text("文")))
    P.append(para(omathpara(omath(limlow(r("min", sty="p"), r("x∈X")), r("f(x)")))))
    P.append(para(text("文"), omath(func(r("log", sty="p"), r("x")), r("+"), func(r("exp", sty="p"), r("x"))),
                  text("文")))
    P.append(para(text("文"), omath(acc(r("y")), r("+"), acc(r("p"), "̅"), r("+"), acc(r("V"), "^")), text("文")))
    P.append(para(text("文"), omath(bar(r("π"), "top"), r("+"), box(r("1"))), text("文")))
    P.append(para(omathpara(omath(eqarr(r("y=a") + frac(r("1"), r("2")))))))
    P.append(para(text("文"), omath(r("收益", sty="p", nor=True), r("=x")), text("文")))
    P.append(para(text("文"), omath(r("R", scr="double-struck"), r("+"), r("L", scr="script"), r("+"),
                                   r("max", sty="p")), text("文")))
    P.append(para(text("文"), omath(r("αβΔπ+123.45+abc")), text("文")))
    return P


def sweep_formulas():
    P = []
    P.append(para(omathpara(omath(r("x="), frac(r("a"), r("b"))))))
    P.append(para(text("文"), omath(r("x="), frac(r("a"), r("b"))), text("文")))
    P.append(para(text("文"), omath(sup(r("x"), r("2")), r("+"), sub(r("x"), r("i")), r("+"),
                                   subsup(r("x"), r("i"), r("2"))), text("文")))
    P.append(para(omathpara(omath(r("x+"), nary("∑", r("i=1"), r("n"), sub(r("x"), r("i")), loc="undOvr")))))
    P.append(para(text("文"), omath(r("x+"), nary("∑", r("i=1"), r("n"), sub(r("x"), r("i")), loc="undOvr"),
                                   r("+"), nary("∑", r("i=1"), r("n"), r("x"), loc="subSup")), text("文")))
    P.append(para(text("文"), omath(r("x+"), d(r("a+b")), r("+"), d(r("a"), beg="[", end="]")), text("文")))
    P.append(para(text("文"), omath(r("x+"), rad(r("x")), r("+"), acc(r("y")), r("+"), acc(r("p"), "̅")),
                  text("文")))
    P.append(para(omathpara(omath(r("x+y")))))
    return P


def spacing():
    P = []
    P.append(T(r("x"), d(r("a")), r("y")))
    P.append(T(r("x"), frac(r("a"), r("b")), r("y")))
    P.append(T(r("−a"), r("="), r("−b")))
    P.append(T(d(r("−a")), r(",−b")))
    P.append(T(r("2⋅3∗4∘5±6")))
    P.append(T(r("a/b:c…d|e")))
    P.append(T(r("x"), nary("∑", r("i"), None, r("y"), loc="subSup"), r("z")))
    P.append(T(func(r("sin"), r("x")), r("+"), func(r("cos", sty="p"), sup(r("x"), r("2")))))
    P.append(T(func(sup(r("sin", sty="p"), r("2")), r("x")), r("+"), func(r("log", sty="p"), d(r("x")))))
    P.append(T(r("f(x)=g(y)"), r("+"), r("a+(−b)")))
    P.append(T(r("x≤y≥z∈A⊆B→C⇒D")))
    P.append(T(r("a+b"), r("+"), r("c", sty="b"), r("+"), r("d", sty="bi"), r("+"), r("F", scr="fraktur"),
               r("+"), r("G", scr="sans-serif")))
    P.append(T(r("收益=x", )))
    P.append(T(r("if ", nor=True), r("x"), r(" 则", nor=True)))
    P.append(D(r("x+y")))
    P.append(D(r("x"), d(r("a")), frac(r("1"), r("2")), r("y")))
    return P


def accents():
    P = []
    P.append(T(acc(r("y")), r("+"), acc(r("p")), r("+"), acc(r("V")), r("+"), acc(r("h")), r("+"), acc(r("A"))))
    P.append(T(acc(r("x"), "̃"), r("+"), acc(r("x"), "̇"), r("+"), acc(r("x"), "̈"), r("+"), acc(r("x"), "⃗"),
               r("+"), acc(r("x"), "̌")))
    P.append(T(acc(r("x"), "̅"), r("+"), acc(r("xy"), "̅"), r("+"), acc(r("xyz")), r("+"), acc(r("Δπ"))))
    P.append(T(acc(r("V"), "^"), r("+"), acc(r("p"), "^"), r("+"), acc(sup(r("x"), r("2")))))
    P.append(T(bar(r("π"), "top"), r("+"), bar(r("xy")), r("+"), bar(r("y"), "top"), r("+"), bar(r("A"), "top")))
    P.append(T(box(r("1")), r("+"), box(r("Verify", sty="p")), r("+"), box(r("+"))))
    P.append(D(acc(r("y")), r("+"), acc(r("p"), "̅"), r("+"), bar(r("π"), "top")))
    return P


def naries():
    P = []
    P.append(D(nary("∑", r("i=1"), r("n"), r("x"), loc="undOvr")))
    P.append(D(nary("∑", r("x"), r("n"), r("x"), loc="undOvr")))
    P.append(D(nary("∑", r("k=1"), r("N"), r("x"), loc="undOvr"), r("+"),
               nary("∑", r("i"), None, r("y"), loc="undOvr")))
    P.append(D(nary(None, r("0"), r("1"), r("f"))))
    P.append(D(nary(None, r("0"), r("1"), r("f"), loc="undOvr")))
    P.append(T(nary(None, r("0"), r("1"), r("f"))))
    P.append(D(nary("∏", r("i"), r("n"), r("x"), loc="undOvr"), r("+"), nary("∬", None, None, r("f"))))
    P.append(D(nary("∑", r("i"), r("n"), frac(r("a"), r("b")), loc="undOvr", grow=True)))
    P.append(D(frac(nary("∑", r("i"), r("n"), r("x"), loc="undOvr"), r("n"))))
    P.append(T(nary("∑", r("i=1"), r("n"), r("x")), r("+"), nary("∑", r("i"), None, r("x"), loc="undOvr")))
    P.append(T(nary("∑", None, None, r("x")), r("+"), nary("∑", r("k=1"), r("N"), sub(r("x"), r("k")), loc="subSup")))
    return P


def fences():
    P = []
    P.append(T(d(r("x")), d(sup(r("x"), r("2"))), d(r("x"), beg="[", end="]"), d(r("x"), beg="{", end="}"),
               d(r("x"), beg="|", end="|"), d(r("x"), beg="‖", end="‖")))
    P.append(T(d(r("x"), beg="⌈", end="⌉"), d(r("x"), beg="⌊", end="⌋"), d(r("x"), beg="⟨", end="⟩"),
               d(r("x"), beg="[", end=")"), d(r("x"), beg="", end="|"), d(r("a"), r("b"), sep="|")))
    P.append(D(d(frac(r("a"), r("b"))), d(frac(r("a"), r("b")), beg="[", end="]"),
               d(frac(r("a"), r("b")), beg="{", end="}"), d(frac(r("a"), r("b")), beg="|", end="|")))
    P.append(D(d(d(frac(r("a"), r("b")))), r("+"), d(frac(frac(r("1"), r("2")), r("3")))))
    P.append(T(d(frac(r("a"), r("b"))), r("+"), d(frac(r("a"), r("b")), grow="0")))
    P.append(D(d(nary("∑", r("i"), r("n"), r("x"), loc="undOvr")), r("+"), d(r("x"), sep="")))
    P.append(T(rad(r("x")), r("+"), rad(sup(r("x"), r("2"))), r("+"), rad(r("x"), r("3")), r("+"),
               rad(frac(r("a"), r("b")))))
    P.append(D(rad(r("x")), r("+"), rad(frac(r("a"), r("b"))), r("+"), rad(r("x"), r("n")), r("+"),
               rad(sub(r("x"), r("i")))))
    P.append(D(rad(frac(frac(r("1"), r("2")), r("3")))))
    return P


def scripts():
    P = []
    P.append(T(sup(r("y"), r("2")), r("+"), sup(r("X"), r("2")), r("+"), sub(r("f"), r("k")), r("+"),
               sup(r("e"), sup(r("x"), r("2"))), r("+"), sub(r("x"), sub(r("i"), r("j")))))
    P.append(T(sup(d(frac(r("a"), r("b"))), r("2")), r("+"), sup(r("x"), frac(r("a"), r("b"))), r("+"),
               sub(d(r("x")), r("i")), r("+"), subsup(d(r("x")), r("i"), r("2"))))
    P.append(T(subsup(r("x"), r("i"), r("2")), r("+"), subsup(r("x"), r("ij"), r("n+1")), r("+"),
               subsup(r("y"), r("k"), r("′"))))
    P.append(D(sup(frac(r("a"), r("b")), r("2")), r("+"), sub(r("x"), frac(r("a"), r("b"))), r("+"),
               subsup(r("x"), r("i"), r("2"))))
    P.append(T(frac(r("a"), r("b"), "lin"), r("+"), frac(r("a"), r("b"), "noBar"), r("+"),
               frac(frac(r("1"), r("2")), r("3"))))
    P.append(D(frac(r("a"), r("b"), "lin"), r("+"), frac(r("a"), r("b"), "noBar"), r("+"),
               frac(frac(frac(r("1"), r("2")), r("3")), r("4"))))
    P.append(D(limlow(r("lim", sty="p"), r("x→0")), r("f"), r("+"), limupp(r("x"), r("n")), r("+"),
               limlow(r("max", sty="p"), r("i"))))
    P.append(T(limlow(r("lim", sty="p"), r("x→0")), r("f"), r("+"), limlow(r("min", sty="p"), r("k")), r("x")))
    P.append(D(eqarr(r("x=1"))))
    P.append(D(r("y="), eqarr(r("x+1"), r("x−1"))))
    P.append(D(eqarr(r("a+b=c"), r("d=e+f"), r("g=h"))))
    return P


def layout():
    P = []
    P.append(D(r("x+y"), jc="left"))
    P.append(D(r("x+y"), jc="right"))
    P.append(D(r("x+y"), jc="center"))
    P.append(para(omathpara(omath(r("x+y=1")), omath(r("a=b")))))
    P.append(para(text("前文"), omathpara(omath(r("x"))), text("后文")))
    P.append(D(frac(r("a"), r("b"))))
    P.append(T(r("x")))
    P.append(para(omath(r("x+y"))))
    P.append(para(omath(frac(r("a"), r("b")))))
    P.append(D(r("y")))
    P.append(para(text("结束")))
    return P


def grow_fences():
    P = []
    contents = [
        lambda: frac(r("a"), r("b")),
        lambda: frac(r("A"), r("B")),
        lambda: frac(r("x"), r("y")),
        lambda: frac(r("1"), r("2")),
        lambda: frac(r("a+b"), r("c")),
        lambda: sup(r("x"), r("2")),
        lambda: sub(r("x"), r("i")),
        lambda: subsup(r("x"), r("i"), r("2")),
        lambda: sup(r("x"), sup(r("2"), r("2"))),
        lambda: frac(r("1"), frac(r("a"), r("b"))),
        lambda: nary("∑", r("i"), r("n"), r("x"), loc="undOvr"),
        lambda: d(frac(r("a"), r("b"))),
        lambda: rad(frac(r("a"), r("b"))),
    ]
    for c in contents:
        P.append(D(d(c()), r("+"), d(c(), beg="[", end="]")))
        P.append(T(d(c()), r("+"), d(c(), beg="[", end="]")))
    return P


def grow_misc():
    P = []
    P.append(D(nary("∑", r("i"), r("n"), frac(frac(r("a"), r("b")), r("c")), loc="undOvr", grow=True)))
    P.append(D(nary("∑", r("i"), r("n"), frac(frac(r("a"), r("b")), r("c")), loc="undOvr")))
    P.append(D(nary("∑", r("i"), r("n"), frac(r("a"), r("b")), loc="undOvr", grow=True)))
    P.append(D(nary("∑", r("i"), r("n"), d(frac(frac(r("a"), r("b")), r("c"))), loc="undOvr", grow=True)))
    P.append(T(nary("∑", r("i"), r("n"), frac(r("a"), r("b")), grow=True)))
    P.append(T(frac(r("a"), r("b"), "lin"), r("+"), frac(r("a+1"), r("2x"), "lin")))
    P.append(D(frac(r("a"), r("b"), "lin"), r("+"), frac(sup(r("x"), r("2")), r("2"), "lin")))
    P.append(T(frac(r("a"), r("b"), "noBar"), r("+"), frac(r("1"), r("2"), "skw")))
    P.append(D(frac(r("a"), r("b"), "noBar")))
    return P


def lin(num, den):
    return frac(num, den, "lin")


def lin_formulas():
    a, b = r("a"), r("b")
    P = []
    P.append(T(lin(a, b)))
    P.append(T(lin(r("1"), r("2"))))
    P.append(T(lin(r("A"), r("B"))))
    P.append(T(lin(r("y"), r("g"))))
    P.append(T(r("x+"), lin(a, b), r("+y")))
    P.append(T(r("x"), lin(a, b), r("y")))
    P.append(T(lin(r("a+1"), r("2x"))))
    P.append(T(lin(sup(r("x"), r("2")), r("2"))))
    P.append(T(lin(sub(r("x"), r("i")), sub(r("y"), r("j")))))
    P.append(T(lin(r("f"), r("f"))))
    P.append(T(lin(frac(a, b), r("c"))))
    P.append(T(d(lin(a, b))))
    P.append(T(sup(r("x"), lin(a, b))))
    P.append(D(lin(a, b)))
    P.append(D(lin(sup(r("x"), r("2")), r("2"))))
    P.append(D(frac(lin(a, b), lin(r("c"), r("d")))))
    P.append(T(r("u="), frac(lin(r("F"), r("N")) + r("+c"), r("(1−r)(1−s)m"))))
    P.append(D(sub(rt("LQ"), rt("ij")), rt("=", sty="p"),
               frac(lin(sub(rt("y"), rt("i")), sub(rt("gdp"), rt("i"))),
                    lin(sub(rt("Y"), rt("i")), sub(rt("GDP"), rt("i"))))))
    P.append(T(lin(a, r("bcdefg"))))
    P.append(T(lin(r("abcdef"), b)))
    P.append(T(lin(rt("y"), rt("g"))))
    P.append(T(lin(a, b), lin(r("c"), r("d"))))
    P.append(D(lin(frac(a, b), r("c"))))
    return P


def nest_formulas():
    P = []

    def ab():
        return frac(r("a"), r("b"))

    P.append(D(d(d(r("x")))))
    P.append(D(d(d(d(r("x"))))))
    P.append(D(d(d(ab()))))
    P.append(D(d(d(d(ab())))))
    P.append(D(d(d(ab(), beg="[", end="]"))))
    P.append(D(d(d(ab()), beg="[", end="]")))
    P.append(D(d(d(ab(), beg="[", end="]"), beg="[", end="]")))
    P.append(D(d(d(ab()) + r("+1"))))
    P.append(D(d(r("1+") + d(ab()))))
    P.append(D(d(d(ab()) + d(frac(r("c"), r("d"))))))
    P.append(D(d(d(ab(), beg="|", end="|"))))
    P.append(D(d(d(sup(r("x"), r("2"))))))
    P.append(D(d(d(ab(), grow="0"))))
    P.append(D(d(frac(r("1"), ab()))))
    P.append(D(d(frac(ab(), r("1")))))
    P.append(D(d(frac(r("1"), frac(r("1"), r("2"))))))
    P.append(D(d(frac(r("1"), r("1+") + ab()))))
    P.append(D(d(frac(r("1"), ab()), beg="[", end="]")))
    P.append(D(frac(r("1"), ab())))
    P.append(D(d(frac(r("x"), sup(r("y"), r("2"))))))
    P.append(D(d(frac(r("1"), d(ab())))))
    P.append(D(d(frac(r("1"), frac(ab(), r("c"))))))
    P.append(D(d(frac(ab(), frac(r("c"), r("d"))))))
    P.append(T(d(d(ab()))))
    P.append(T(d(frac(r("1"), ab()))))
    P.append(T(d(d(r("x")))))
    P.append(T(d(d(sup(r("x"), r("2"))))))
    return P


def suph_formulas():
    P = []

    def ab():
        return frac(r("a"), r("b"))

    def x2():
        return sup(r("x"), r("2"))

    P.append(D(x2()))
    P.append(D(d(x2())))
    P.append(D(d(x2(), beg="[", end="]")))
    P.append(D(d(x2(), grow="0")))
    P.append(D(d(r("x"))))
    P.append(D(d(r("x+") + sup(r("y"), r("2")))))
    P.append(D(d(sup(r("x"), r("n")))))
    P.append(D(d(sup(r("A"), r("2")))))
    P.append(D(d(sup(r("e"), r("x")))))
    P.append(D(d(sub(r("x"), r("2")))))
    P.append(D(d(x2() + sub(r("y"), r("i")))))
    P.append(D(sup(d(r("x")), r("2"))))
    P.append(D(sup(ab(), r("2"))))
    P.append(D(sub(ab(), r("2"))))
    P.append(D(sup(d(ab()), r("2"))))
    P.append(D(sup(rad(r("x")), r("2"))))
    P.append(D(sub(d(r("x")), r("i"))))
    P.append(D(subsup(d(ab()), r("i"), r("2"))))
    P.append(D(x2(), r("+"), d(r("y"))))
    P.append(D(sup(r("xy"), r("2"))))
    P.append(D(sub(r("xy"), r("i"))))
    P.append(D(sub(r("gdp"), r("i"))))
    P.append(D(sub(r("p"), r("i"))))
    P.append(D(sup(r("ab"), r("2"))))
    P.append(D(sub(rt("gdp"), rt("i"))))
    P.append(D(sub(rt("LQ"), rt("ij"))))
    P.append(D(sup(r("sin", sty="p"), r("2"))))
    P.append(D(sup(acc(r("x")), r("2"))))
    P.append(D(sup(bar(r("x"), "top"), r("2"))))
    P.append(T(d(x2())))
    P.append(T(sup(ab(), r("2"))))
    P.append(T(sub(r("gdp"), r("i"))))
    P.append(T(sup(d(r("x")), r("2"))))
    return P


LETTERS = "abcdefghijklmnopqrstuvwxyz"


def chain(op, n, start=0):
    return op.join(LETTERS[(start + i) % 26] for i in range(n))


def wrap_formulas():
    """超出版心的公式。行内用例的文字长度按字号缩放，使公式在 12 与 24 磅下都从行中部开始。"""
    k = 24 / Ctx.sz
    P = []
    P.append(D(r("y=" + chain("+", 40))))
    P.append(D(r(chain("+", 70))))
    P.append(D(r(chain("=", 40))))
    P.append(D(r("y=" + chain("−", 40))))
    P.append(D(r("y=" + chain("×", 40))))
    P.append(D(r(chain(",", 60))))
    P.append(D(r(LETTERS * 3)))
    P.append(D(r("y="), *[frac(r(LETTERS[i % 26]), r("2")) + r("+") for i in range(29)], frac(r("z"), r("2"))))
    P.append(D(d(r(chain("+", 40)))))
    P.append(D(r("S="), nary("∑", r("i=1"), r("n"), r(chain("+", 40)), loc="undOvr")))
    P.append(D(r("y=" + chain("+", 40)), jc="left"))
    P.append(D(r("y=" + chain("+", 40)), jc="right"))
    P.append(D(r("y=" + chain("+", 40)), jc="center"))
    P.append(para(omathpara(omath(r("y=" + chain("+", 20))), omath(r("z=" + chain("+", 20, 5))))))
    P.append(para(omath(r("y=" + chain("+", 40)))))
    P.append(para(text("文字" * int(10 * k)), omath(r(chain("+", 30))), text("文字" * int(5 * k))))
    P.append(para(text("文字" * int(18 * k)), omath(r("x+y=z")), text("文字")))
    P.append(para(text("文"), omath(r(chain("+", 60))), text("文")))
    P.append(para(text("文字" * int(18 * k)), omath(frac(r("a"), r("b")), r("+"), frac(r("c"), r("d"))),
                  text("文字")))
    P.append(D(r("y=" + chain("+", 24) + "+"), d(r("a+b")), r("+" + chain("+", 15))))
    P.append(D(r("y=" + chain("+", 15) + "=" + chain("+", 15, 3) + "=" + chain("+", 15, 7))))
    return P


def nor_formulas():
    """首个字符的字体决定行高的下限；东亚字符按其字体的单倍行高加 mathLeading。"""
    def b(parens=True, font="Noto Serif CJK SC"):
        x = lambda t: nr(t, ea=font, hint="default")  # noqa: E731
        parts = [x("T"), sub(x("L"), x("t")), x("="), sub(x("Σ"), x("i")), sub(x("y"), x("i")), x("t·ln("),
                 sub(x("y"), x("i")), x("t/"), sub(x("l"), x("i")), x("t),")]
        return "".join(parts + ([ea("（"), x("i=1,2,3"), ea("）")] if parens else []))
    L = lambda: sub(nr("L"), nr("t"))  # noqa: E731
    P = []
    for xs in ([r("x")], [nr("x")], [nr("T")], [nr("Tyl")], [r("x"), ea("（")], [r("x"), ea("（"), nr("i"), ea("）")],
               [r("x"), r("收益")], [r("x"), nr("收益")], [r("x"), ea("（", font="微软雅黑")], [r("x"), ea("收", font="黑体")],
               [r("x"), nr("x", ascii="微软雅黑", ea="微软雅黑")], [r("x"), nr("x", ascii="宋体")], [L()], [r("x"), nr("=")],
               [b()], [b(parens=False)], [b(font="宋体")], [r("x"), sub(nr("x"), ea("收"))], [r("x"), sup(r("y"), nr("收"))],
               [r("x"), r("（")], [nr("T"), r("x")], [r("x"), nr("T")], [nr("T"), L()], [L(), nr("T")],
               [sub_ctrl(nr("L"), nr("t"), "Times New Roman")], [sub_ctrl(nr("L"), nr("t"), None)],
               [nr("x", ascii="Arial")], [nr("x", ascii="Calibri")], [nr("x", ascii="微软雅黑", ea="微软雅黑")],
               [nr("x", ascii="宋体")], [ea("（")], [nr("T"), ea("（")], [frac(nr("a"), nr("b"))], [nr("y"), sup(r("x"), r("2"))],
               [r("x"), nr("x", ascii="Calibri")], [r("收")], [nr("x", ascii="Cambria Math")], [nr("x", ascii="Cambria")],
               [mr("x", "Times New Roman")], [mr("x")], [mr("x", "微软雅黑")], [r("x"), ea("·")], [r("x"), ea("“")],
               [r("x"), ea("α")], [mr("收", "Times New Roman")]):
        P.append(D(*xs))
    for xs in ([nr("x")], [r("x")], [r("x"), ea("（")], [nr("T"), ea("（")], [nr("x", ascii="微软雅黑", ea="微软雅黑")],
               [L()], [nr("T"), L()], [frac(r("a"), r("b"))], [mr("x", "Times New Roman")]):
        P.append(para(small("a"), omath(*xs), small("b")))
    P.append(para(text("结束")))
    return P


def zones_formulas():
    ab = lambda: frac(r("a"), r("b"))  # noqa: E731
    S = lambda: nary("∑", r("i=1"), r("n"), r("x"), loc="undOvr")  # noqa: E731
    P = [D(ab()), D(S())]
    for zs in ([ab(), r("x+1")], [r("x+1"), ab()], [S(), r("y")], [r("a"), r("+b")], [r("a+"), r("b")], [r("x"), ab()],
               [r("x"), r("y"), r("z")], [ab(), ab()]):
        P.append(para(omathpara(*(omath(z) for z in zs))))
        P.append(para(*(omath(z) for z in zs)))
    P.append(para(text("结束")))
    return P


def noctrl_formulas():
    ab = lambda: frac(r("a"), r("b"))  # noqa: E731
    S = lambda: nary("∑", r("i=1"), r("n"), r("x"), loc="undOvr")  # noqa: E731
    P = [D(r("x+y")), D(ab()), D(rad(r("x"))), D(d(ab()))]
    for xs in ([ab()], [S()], [d(ab())], [sup(r("x"), r("2"))], [rad(r("x"))], [r("y="), ab()]):
        P.append(noctrl(D(*xs)))
    P.append(noctrl(T(ab())))
    P.append(T(ab()))
    P.append(noctrl(para(omath(ab()))))
    P.append(para(text("结束")))
    return P


def lim_formulas():
    U = lambda: limupp(r("x"), r("n"))  # noqa: E731
    L = lambda: limlow(r("max", sty="p"), r("i"))  # noqa: E731
    P = []
    for xs in ([r("a+"), U(), r("+b")], [r("a"), U(), r("b")], [r("a+"), L(), r("+b")], [r("a"), L(), r("b")],
               [U(), r("+b")], [L(), r("+b")], [r("a+"), limupp(r("x"), r("nnnn"))],
               [r("a+"), limlow(r("lim", sty="p"), r("x→0")), r("+b")], [r("a="), U(), r("=b")]):
        P.append(D(*xs))
    P.append(T(r("a+"), U(), r("+b")))
    P.append(T(r("a+"), L(), r("+b")))
    P.append(para(text("结束")))
    return P


def rsz(t, sz):
    """数学字段，字号为 sz（半磅），与 Ctx.sz 无关。"""
    return (f'<m:r><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/><w:sz w:val="{sz}"/></w:rPr>'
            f'<m:t xml:space="preserve">{escape(t)}</m:t></m:r>')


def rad_at(x, sz):
    """不显示根指数的根号，结构字号为 sz（半磅）。"""
    c = f'<m:ctrlPr><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/><w:sz w:val="{sz}"/></w:rPr></m:ctrlPr>'
    return f'<m:rad><m:radPr><m:degHide m:val="1"/>{c}</m:radPr><m:deg/>{e(x)}</m:rad>'


def radical_formulas():
    ab = lambda: frac(r("a"), r("b"))  # noqa: E731
    P = [D(rad(x)) for x in (r("x"), r("y"), r("A"), ab(), sub(r("x"), r("i")), sup(r("x"), r("2")))]
    P += [D(r("x+"), rad(r("x"))), D(rad(r("x")), r("+y")), D(rad(frac(r("1"), ab()))), D(rad(r("x"), r("3"))),
          D(sup(rad(r("x")), r("2"))), D(frac(r("1"), rad(r("x")))), D(frac(rad(r("x")), r("2"))),
          D(d(frac(r("a"), rad(r("d"))))), D(rad(r("x")), rad(r("y"))), T(rad(r("x")))]
    P.append(para(text("结束")))
    return P


def radsize_formulas():
    """根号字号 10.5 磅，被开方式 x、y、A 的字号逐级变化（变体选择的临界）。"""
    P = [D(rad_at(rsz("x", sz), 21)) for sz in range(28, 51)]
    P += [D(rad_at(rsz(t, sz), 21)) for t in "yA" for sz in range(24, 41, 2)]
    P.append(para(text("结束")))
    return P


def limits_formulas():
    U = lambda: limupp(r("x"), r("n"))  # noqa: E731
    L = lambda: limlow(r("max", sty="p"), r("i"))  # noqa: E731
    ab = lambda: frac(r("a"), r("b"))  # noqa: E731
    low = lambda: limlow(r("min", sty="p"), r("i"))  # noqa: E731
    P = []
    for xs in ([r("a+"), U(), r("+b")], [r("a+"), U(), r("b")], [r("a"), U(), r("+b")], [r("a="), U(), r("b")],
               [r("a,"), U(), r("b")], [d(U())], [U(), r("b")], [U(), r("+b")], [ab(), U(), r("b")],
               [r("a+"), limupp(r("x"), r("nnnnnn")), r("+b")], [r("a+"), limupp(r("xxxx"), r("n")), r("+b")],
               [r("a+"), L(), r("+b")], [L()], [r("a="), L()], [r("a+"), U()],
               [r("a+"), U(), r("+"), limupp(r("y"), r("m")), r("+b")],
               [r("a+"), func(limlow(r("lim", sty="p"), r("x")), r("x"))], [U()], [r("a−"), low()], [r("a=−"), low()],
               [r("a⋅"), U(), r("b")], [r("a→"), U(), r("b")]):
        P.append(D(*xs))
    P.append(T(r("a+"), U(), r("+b")))
    P.append(T(U(), r("+b")))
    P.append(para(text("结束")))
    return P


def denom_formulas():
    """分母、下标中的上标，以及括住分数的括号（含语料中的写法）。"""
    ab = lambda: frac(r("a"), r("b"))  # noqa: E731
    y2 = lambda: sup(r("y"), r("2"))  # noqa: E731
    qk = lambda: r("Q") + sup(r("K"), r("T"))  # noqa: E731
    P = [D(frac(r("x"), y2())), D(d(frac(r("x"), y2()))), D(frac(r("x"), sub(r("y"), r("2")))),
         D(frac(r("x"), subsup(r("y"), r("i"), r("2")))), D(frac(sup(r("x"), r("2")), r("y"))),
         D(d(frac(sup(r("x"), r("2")), r("y")))), D(frac(r("a"), sup(r("b"), r("2")))),
         D(d(frac(r("a"), sup(r("b"), r("2"))))), D(rad(sup(r("x"), r("2")))), D(sub(r("x"), y2())),
         D(frac(r("1"), ab())), D(d(frac(r("1"), ab()))), D(d(frac(r("1"), r("a")))), D(d(frac(qk(), rad(r("d"))))),
         D(d(frac(qk(), rad(sub(r("d"), r("k")))))), D(d(frac(qk(), rad(r("d"))) + r("+B"))),
         D(d(r("1+") + func(r("cos", sty="p"), frac(r("tπ"), r("T"))))),
         D(d(r("−") + frac(sup(r("‖x−x'‖"), r("2")), r("2") + sup(r("l"), r("2"))))),
         D(d(frac(r("a+b"), r("c+d")))), D(d(ab() + r("+") + frac(r("c"), r("d")))),
         D(d(sup(r("x"), frac(r("1"), r("2"))))), T(d(frac(r("x"), y2())))]
    P.append(para(text("结束")))
    return P


def cramp_formulas():
    """上标 x² 所在的位置：分母、下标、根号、重音、上下横线、n 元运算符下限、上下极限（显示与行内）。"""
    x2 = lambda: sup(r("x"), r("2"))  # noqa: E731
    P = []
    for f in (lambda: frac(r("1"), x2()), lambda: sub(r("y"), x2()), lambda: rad(x2()), lambda: acc(x2()),
              lambda: bar(x2(), "top"), lambda: bar(x2(), "bot"),
              lambda: nary("∑", x2(), r("n"), r("y"), loc="undOvr"), lambda: nary("∑", x2(), r("n"), r("y"), loc="subSup"),
              lambda: limlow(r("lim", sty="p"), x2()), lambda: limupp(r("lim", sty="p"), x2()), x2):
        P.append(D(f()))
        P.append(T(f()))
    P.append(para(text("结束")))
    return P


def ms(t, font, sty):
    """数学字段：font 为 None 时不写 w:rFonts，sty 为 None 时不写 m:sty。"""
    f = f'<w:rFonts w:ascii="{font}" w:hAnsi="{font}"/>' if font else ""
    m = f'<m:rPr><m:sty m:val="{sty}"/></m:rPr>' if sty else ""
    return f'<m:r>{m}<w:rPr>{f}{size()}</w:rPr><m:t xml:space="preserve">{escape(t)}</m:t></m:r>'


def plain_formulas():
    """m:sty 与字段字体：Times New Roman 的 m:sty="p" 字段中的各类字符，各种 m:sty 与各种字体。"""
    tnr = "Times New Roman"
    P = [D(ms(t, tnr, "p")) for t in ("P", "max", "1", "=", "+", "(", "α", "∑", "P1", "é")]
    P += [D(ms("P", tnr, st)) for st in ("b", "i", "bi", None)]
    P += [D(ms("P", fo, "p")) for fo in ("Arial", "宋体", "STIX Math", None, "Cambria Math", "Calibri")]
    P += [D(ms("P", tnr, "p"), ms("=", "Cambria Math", "p"), ms("x", None, None)), D(ms("x", None, None), ms("P", tnr, "p")),
          T(ms("P", tnr, "p"))]
    P.append(para(text("结束")))
    return P


def mh(t):
    """带东亚提示的 m:sty="p" 数学字段（w:ascii 为 Times New Roman，不写 w:eastAsia）。"""
    return (f'<m:r><m:rPr><m:sty m:val="p"/></m:rPr><w:rPr><w:rFonts w:hint="eastAsia" w:ascii="Times New Roman" '
            f'w:hAnsi="Times New Roman" w:cs="Times New Roman"/>{size()}</w:rPr><m:t>{escape(t)}</m:t></m:r>')


HINT_CHARS = "αβγΑΩμπ·“”‘’…—×÷°±§→←∈≤≥∞√∑①Ⅰаé‰′※℃№★○■△─¨"


def hint_formulas():
    """东亚提示：普通文字字段（宋体）与 m:sty="p" 数学字段中各字符的绘制字体与行高。"""
    P = [D(r("x"), ea(ch)) for ch in HINT_CHARS]
    P += [D(r("x"), mh(ch)) for ch in "αμλεΑ·“×"]
    P += [D(mh("α")), D(ea("α")), D(r("x"), nr("α")), para(text("结束"))]
    return P


def boxes_formulas():
    """m:box 的内容（单独、与运算符相邻、在关系符之后）。"""
    ab = lambda: frac(r("a"), r("b"))  # noqa: E731
    P = [T(box(x)) for x in (r("1"), r("Verify", sty="p"), r("12"), r("ab"), r("a+b"), r("x"))]
    P += [T(box(r("1")), r("+"), box(r("1"))), T(box(r("Sign", sty="p"))), T(box(r("+"))), D(box(r("1"))),
          D(box(r("Verify", sty="p"))), T(box(ab())), T(r("G="), box(r("1")), r("[N<K]")), para(text("结束"))]
    return P


WRAP_SIZES = (24, 48)

GROUPS = {
    "size": (size_formulas, (21, 24, 48, 96, 192)),
    "sweep": (sweep_formulas, (16, 18, 20, 21, 22, 23, 24, 26, 28, 30, 32, 36, 40, 44, 48, 56, 64, 72, 96, 144)),
    "spacing": (spacing, (24, 48)),
    "accents": (accents, (24, 48)),
    "naries": (naries, (24, 48)),
    "fences": (fences, (24, 48)),
    "scripts": (scripts, (24, 48)),
    "layout": (layout, (24, 48)),
    "grow": (grow_fences, (24, 48, 96)),
    "misc": (grow_misc, (24, 48, 96)),
    "lin": (lin_formulas, (21, 24, 30, 48, 64, 96)),
    "nest": (nest_formulas, (24, 48)),
    "suph": (suph_formulas, (21, 24, 48)),
    "wrap-before": (wrap_formulas, WRAP_SIZES),
    "wrap-after": (wrap_formulas, WRAP_SIZES, mathpr(brk="after")),
    "wrap-repeat": (wrap_formulas, WRAP_SIZES, mathpr(brk="repeat")),
    "wrap-repeat-mp": (wrap_formulas, WRAP_SIZES, mathpr(brk="repeat", sub="-+")),
    "wrap-repeat-pm": (wrap_formulas, WRAP_SIZES, mathpr(brk="repeat", sub="+-")),
    "wrap-indent": (wrap_formulas, WRAP_SIZES, mathpr(wrap='<m:wrapIndent m:val="720"/>')),
    "wrap-right": (wrap_formulas, WRAP_SIZES, mathpr(wrap='<m:wrapIndent m:val="1440"/><m:wrapRight/>')),
    "nor": (nor_formulas, (21, 24, 32, 48)),
    "zones": (zones_formulas, (21, 24, 48)),
    "noctrl": (noctrl_formulas, (22, 24, 28, 32, 40, 48), MATHPR, 21),
    "lim": (lim_formulas, (24, 48)),
    "radical": (radical_formulas, (48, 96, 144)),
    "radsize": (radsize_formulas, (21,), MATHPR, 21),
    "limits": (limits_formulas, (48, 96)),
    "denom": (denom_formulas, (24, 48)),
    "cramp": (cramp_formulas, (48, 96)),
    "plain": (plain_formulas, (48,)),
    "hint": (hint_formulas, (48,)),
    "boxes": (boxes_formulas, (24, 48)),
}


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    names = sys.argv[2:] or list(GROUPS)
    for name in names:
        make, sizes, *rest = GROUPS[name]
        pr = rest[0] if rest else MATHPR
        default = rest[1] if len(rest) > 1 else None
        for sz in sizes:
            Ctx.sz = sz
            write_docx(out / f"{name}-{sz:03d}.docx", make(), sz=default or sz, mathpr=pr)
    print("ok")


if __name__ == "__main__":
    main()
