# -*- coding: utf-8 -*-
"""纯 python-pptx 生成《工业自动化 AI Agent 闭环架构 v1.1》汇报 PPT（16:9）。
不依赖 PowerPoint 安装；框架函数（rect/textbox/shape_text/table/arrow/add_slide）可复用于批量报告生成。
用法: python pptx_gen.py [输出.pptx]
"""
import sys
import datetime
from pptx import Presentation
from pptx.util import Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn

OUT = sys.argv[1] if len(sys.argv) > 1 else r"D:\Tools\deepseek-harness\design-proposals\工业自动化AI-Agent闭环架构-v1.1.pptx"

FONT = "微软雅黑"
# 颜色
DARK   = RGBColor(15, 42, 74)
BLUE   = RGBColor(31, 56, 100)
BLUE2  = RGBColor(47, 84, 150)
BLUE3  = RGBColor(68, 114, 196)
BLUE4  = RGBColor(142, 170, 219)
BLUE5  = RGBColor(189, 204, 231)
ACCENT = RGBColor(0, 120, 212)
ORANGE = RGBColor(192, 80, 40)
WHITE  = RGBColor(255, 255, 255)
BLACK  = RGBColor(30, 30, 30)
GRAY   = RGBColor(89, 89, 89)
LIGHT  = RGBColor(243, 246, 250)
GOLD   = RGBColor(255, 217, 102)
REDBG  = RGBColor(120, 40, 40)
GREENBG = RGBColor(15, 90, 60)
SOFT   = RGBColor(200, 210, 225)


def P(v):
    """点 → EMU"""
    return int(v * 12700)


def set_ea(run):
    """设置东亚字体"""
    rPr = run._r.get_or_add_rPr()
    ea = rPr.find(qn("a:ea"))
    if ea is None:
        ea = rPr.makeelement(qn("a:ea"), {})
        rPr.append(ea)
    ea.set("typeface", FONT)


def style_paragraphs(tf, size, color, bold, align, spacing=1.12):
    for p in tf.paragraphs:
        p.alignment = align
        try:
            p.line_spacing = spacing
        except Exception:
            pass
        for r in p.runs:
            r.font.size = Pt(size)
            r.font.bold = bold
            r.font.color.rgb = color
            r.font.name = FONT
            set_ea(r)


def rect(slide, l, t, w, h, fill, shape=MSO_SHAPE.RECTANGLE):
    sp = slide.shapes.add_shape(shape, P(l), P(t), P(w), P(h))
    sp.fill.solid()
    sp.fill.fore_color.rgb = fill
    sp.line.fill.background()
    try:
        sp.shadow.inherit = False
    except Exception:
        pass
    return sp


def shape_text(sp, text, size=12, color=BLACK, bold=False,
               align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.MIDDLE, ml=8, mt=4):
    tf = sp.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = Pt(ml)
    tf.margin_right = Pt(ml)
    tf.margin_top = Pt(mt)
    tf.margin_bottom = Pt(mt)
    tf.text = text  # \n → 段落；\v → 段内换行
    style_paragraphs(tf, size, color, bold, align)
    return sp


def textbox(slide, l, t, w, h, text, size=14, color=BLACK, bold=False, align=PP_ALIGN.LEFT):
    tb = slide.shapes.add_textbox(P(l), P(t), P(w), P(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.text = text
    style_paragraphs(tf, size, color, bold, align)
    return tb


def arrow(slide, l, t, w=34, h=26):
    sp = rect(slide, l, t, w, h, ACCENT, MSO_SHAPE.RIGHT_ARROW)
    return sp


def add_table(slide, data, l, t, w, size=11):
    rows, cols = len(data), len(data[0])
    gf = slide.shapes.add_table(rows, cols, P(l), P(t), P(w), P(20 * rows))
    tbl = gf.table
    tbl.first_row = False
    tbl.horz_banding = False
    for r, row in enumerate(data):
        tbl.rows[r].height = Pt(20)
        for c, val in enumerate(row):
            cell = tbl.cell(r, c)
            cell.fill.solid()
            cell.fill.fore_color.rgb = BLUE if r == 0 else (LIGHT if r % 2 == 0 else WHITE)
            cell.margin_left = Pt(4)
            cell.margin_right = Pt(4)
            cell.margin_top = Pt(2)
            cell.margin_bottom = Pt(2)
            tf = cell.text_frame
            tf.word_wrap = True
            tf.text = val
            for p in tf.paragraphs:
                for run in p.runs:
                    run.font.size = Pt(size)
                    run.font.bold = (r == 0)
                    run.font.color.rgb = WHITE if r == 0 else BLACK
                    run.font.name = FONT
                    set_ea(run)
    return tbl


def add_slide(prs, title, sub=""):
    s = prs.slides.add_slide(prs.slide_layouts[6])  # Blank
    rect(s, 0, 0, 960, 66, DARK)
    textbox(s, 30, 12, 880, 46, title, size=21, color=WHITE, bold=True)
    rect(s, 0, 66, 960, 4, ACCENT)
    if sub:
        textbox(s, 30, 80, 900, 30, sub, size=12, color=GRAY)
    return s


# ---------------- 页面内容 ----------------

def s01_cover(prs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    rect(s, 0, 0, 960, 540, DARK)
    rect(s, 0, 300, 960, 4, ACCENT)
    textbox(s, 60, 120, 840, 150,
            "工业自动化生产系统工程落地之\n全程 AI Agent 全自动自主完成闭环设计架构",
            size=30, color=WHITE, bold=True, align=PP_ALIGN.CENTER)
    textbox(s, 60, 290, 840, 50, "模型生成 · 系统裁决 · 人类把关",
            size=20, color=GOLD, bold=True, align=PP_ALIGN.CENTER)
    textbox(s, 60, 400, 840, 90,
            "架构设计 v1.1 · 汇报版\n覆盖：需求 → 设计 → 实现 → 仿真 → 现场 → 验收 → 运维 全生命周期\n导出日期：%s"
            % datetime.date.today().isoformat(),
            size=13, color=SOFT, align=PP_ALIGN.CENTER)


def s02_summary(prs):
    s = add_slide(prs, "执行摘要（面向决策层）")
    textbox(s, 40, 100, 880, 240, "\n".join([
        "▪ 问题：工业自动化项目交付周期长、依赖个人经验、知识复用率低",
        "▪ 方案：多 Agent 体系 + “验证即门禁”，需求→设计→编程→仿真→部署→运维全链路自主闭环",
        "▪ 核心原则：模型负责生成，确定性工具负责裁决，人类负责把关",
        "▪ 预期收益：项目周期 -40% 以上，现场调试工时 -50% 以上，知识复用率 ≥60%",
        "▪ 落地路径：四阶段渐进（助手→受控半自动→受限全自动→学习型全自动）",
        "▪ 投资估算（示例）：¥115–245 万初始投入，1.5–2.5 年回收（10 项目/年规模）",
    ]), size=15)
    textbox(s, 40, 380, 880, 50,
            "红 线：安全事故数为 0 ｜ SIL3+ 安全功能不自动生成 ｜ 危险操作永远人工闸门",
            size=16, color=ORANGE, bold=True)


def s03_problem(prs):
    s = add_slide(prs, "问题与目标：让 Agent 成为“工程主体”")
    shape_text(rect(s, 40, 110, 420, 200, REDBG, MSO_SHAPE.ROUNDED_RECTANGLE),
               "传统痛点\n\v周期长、高度依赖资深工程师个人经验\v需求变更与现场调试反复迭代\v知识沉淀差、复用率低",
               size=14, color=WHITE)
    arrow(s, 470, 190)
    shape_text(rect(s, 520, 110, 420, 200, GREENBG, MSO_SHAPE.ROUNDED_RECTANGLE),
               "架构目标\n\v以可验证、可追溯、可回滚的方式\v自主完成需求→运维全程闭环\v经验沉淀为随项目增长的学习闭环",
               size=14, color=WHITE)
    textbox(s, 40, 340, 880, 130, "\n".join([
        "▪ 质量由确定性验证器强制把关，而非依赖模型自觉",
        "▪ 人工介入收敛为预先声明的“闸门”，全部留痕可审计",
        "▪ 范围排除：SIL3+ 自动生成、特种设备自动签批、强物理交互全自主",
    ]), size=14)


def s04_loops(prs):
    s = add_slide(prs, "总体架构：三闭环嵌套")
    shape_text(rect(s, 30, 130, 280, 170, BLUE, MSO_SHAPE.ROUNDED_RECTANGLE),
               "工程闭环（主体）\n\v需求→设计→实现→验证→交付\v自动化程度逐级提升", size=14, color=WHITE)
    arrow(s, 320, 195)
    shape_text(rect(s, 370, 130, 280, 170, BLUE2, MSO_SHAPE.ROUNDED_RECTANGLE),
               "运行闭环（反哺）\n\v生产数据→诊断/优化→再部署\v现场数据反哺工程", size=14, color=WHITE)
    arrow(s, 660, 195)
    shape_text(rect(s, 710, 130, 220, 170, BLUE3, MSO_SHAPE.ROUNDED_RECTANGLE),
               "学习闭环（增强）\n\v经验→案例/模板/标准库\v随项目增长而增强", size=14, color=WHITE)
    textbox(s, 40, 340, 880, 120, "\n".join([
        "▪ 工程闭环是主体：每阶段产出经确定性验证器放行（验证即门禁）",
        "▪ 运行闭环把生产现场数据回灌设计；学习闭环把项目经验沉淀复用",
    ]), size=14)


def s05_layers(prs):
    s = add_slide(prs, "总体架构：六层分层")
    layers = [
        ("L5 人机协作层", "监督面板 · 审批流 · 任务分配（人只走预定义入口，全程留痕）", DARK, WHITE),
        ("L4 编排与治理层", "Orchestrator 编排 · 任务分解 · 闸门与升级引擎 · 全量审计", BLUE, WHITE),
        ("L3 Agent 执行层", "9 个专业 Agent：需求/设计/电气/程序/HMI/仿真/文档/现场/运维", BLUE2, WHITE),
        ("L2 工具与协议层", "MCP/A2A 总线 · TIA/CODESYS/TwinCAT · E-CAD · 仿真 · OPC UA · 版本库", BLUE3, WHITE),
        ("L1 数据与知识层", "标准/模板/案例库（RAG）· 数字孪生模型库 · 全链路追溯库", BLUE4, BLACK),
        ("L0 基础设施层", "LLM 服务（通用+领域）· 算力与边缘节点 · 存储（现场可离线）", BLUE5, BLACK),
    ]
    y = 100
    for name, desc, fill, fcolor in layers:
        shape_text(rect(s, 40, y, 880, 60, fill), name + "\n\v" + desc, size=12, color=fcolor)
        y += 68


def s06_gate(prs):
    s = add_slide(prs, "核心机制：验证即门禁（Verify-as-Gate）")
    shape_text(rect(s, 40, 100, 880, 44, BLUE, MSO_SHAPE.ROUNDED_RECTANGLE),
               "生成 → 验证 → 放行 / 驳回        （确定性验证器裁决，不依赖模型自觉）",
               size=15, color=WHITE, align=PP_ALIGN.CENTER)
    add_table(s, [
        ["专业域", "验证器示例", "输出证据"],
        ["控制程序", "PLC 编译 / Lint（命名、未用变量、禁止指令）", "编译日志、Lint 报告"],
        ["电气设计", "E-CAD 规则检查（短路、未连接端子、物料校验）", "规则检查报告"],
        ["需求", "完整性 + 一致性 + 可测性检查", "追溯矩阵、缺口报告"],
        ["仿真", "数字孪生虚拟调试用例（节拍/联锁/报警/故障注入）", "通过率、时序数据"],
        ["安全", "IEC 61511 / ISO 13849 / IEC 62061 条款初查", "符合性初查表（人工终审）"],
        ["网络", "IEC 62443 分区检查、未授权端口清单", "配置审计报告"],
    ], 40, 165, 880, size=11.5)
    textbox(s, 40, 400, 880, 60,
            "双 Agent 交叉评审仅作辅助证据，不替代确定性验证器；安全关键逻辑可引入形式化验证（nuXmv/PLCverif）",
            size=13, color=GRAY)


def s07_agents(prs):
    s = add_slide(prs, "Agent 体系：9 个专业 Agent + 编排器")
    agents = [
        ("需求工程", "协议/URS→需求矩阵+澄清问题"),
        ("方案设计", "架构选型·IO 估算·SIL 初评"),
        ("电气设计", "原理图·IO 清单·BOM 校验"),
        ("控制程序", "IEC 61131-3 生成+编译内环"),
        ("HMI/SCADA", "画面/报警组态+一致性校验"),
        ("仿真验证", "数字孪生虚拟调试·故障注入"),
        ("文档合规", "文档包+符合性初查+HAZOP/FMEA"),
        ("现场实施", "点检/联调脚本+诊断（上电人工）"),
        ("运行运维", "根因分析+优化提案回灌闭环"),
    ]
    for idx, (name, desc) in enumerate(agents):
        x = 25 + (idx % 3) * 310
        y = 105 + (idx // 3) * 95
        shape_text(rect(s, x, y, 290, 32, BLUE2, MSO_SHAPE.ROUNDED_RECTANGLE),
                   name, size=13, color=WHITE, bold=True)
        shape_text(rect(s, x, y + 32, 290, 48, LIGHT), desc, size=10.5, color=BLACK)
    shape_text(rect(s, 25, 400, 910, 70, BLUE, MSO_SHAPE.ROUNDED_RECTANGLE),
               "编排器 Orchestrator：DAG 任务分解 · 调度与失败升级 · 多项目隔离（无权批准闸门）",
               size=13, color=WHITE, align=PP_ALIGN.CENTER)


def s08_loops_mech(prs):
    s = add_slide(prs, "闭环机制：内环 / 外环 / 学习环")
    shape_text(rect(s, 30, 105, 290, 210, BLUE, MSO_SHAPE.ROUNDED_RECTANGLE),
               "内闭环 · 自动修复\n\v生成 → 验证 fail → 诊断 → 修复 → 重验\v重试默认 ≤3 次，超出即升级\v修复以验证器输出为依据",
               size=12.5, color=WHITE)
    shape_text(rect(s, 335, 105, 290, 210, BLUE2, MSO_SHAPE.ROUNDED_RECTANGLE),
               "外闭环 · 人工介入\n\v升级包必含：上下文 + 产物与证据\v+ 失败原因 + 候选方案\v裁决回写状态机并成为学习样本",
               size=12.5, color=WHITE)
    shape_text(rect(s, 640, 105, 290, 210, BLUE3, MSO_SHAPE.ROUNDED_RECTANGLE),
               "学习闭环 · 经验沉淀\n\v通过产物→模板库；失败-修复对→案例库\v人工裁决→规则库；现场变更→变更案例库\v学习管线初筛 + 人工定期审核",
               size=12.5, color=WHITE)
    textbox(s, 30, 360, 900, 60,
            "三环贯通：内环保质量，外环保可控，学习环让体系随项目数量增长而增强",
            size=15, bold=True, align=PP_ALIGN.CENTER)


def s09_trace(prs):
    s = add_slide(prs, "全链路可追溯 + 变更影响分析")
    textbox(s, 40, 100, 880, 140, "\n".join([
        "▪ 四库联动、单一数据源：需求库 / 工程资产仓库 / 追溯库 / 验证证据库，以需求 ID 贯通全程",
        "▪ 资产即代码：图纸/程序/组态/测试全部版本化，Agent 一切修改可 diff、可回滚",
        "▪ 每次生成记录：输入版本、模型与提示词版本、验证证据、Agent/人身份、时间戳",
    ]), size=14)
    shape_text(rect(s, 40, 280, 880, 60, BLUE, MSO_SHAPE.ROUNDED_RECTANGLE),
               "变更影响分析（有向图遍历）\v需求节点→设计节点→实现节点→测试节点，变更沿图正向遍历下游可达节点",
               size=13, color=WHITE, align=PP_ALIGN.CENTER)
    shape_text(rect(s, 40, 355, 275, 130, ORANGE, MSO_SHAPE.ROUNDED_RECTANGLE),
               "直接影响\n\v同一节点产物需重新生成\v自动触发重新生成+验证", size=12.5, color=WHITE)
    shape_text(rect(s, 335, 355, 275, 130, BLUE2, MSO_SHAPE.ROUNDED_RECTANGLE),
               "间接影响\n\v下游节点需重新验证\v进入待办队列", size=12.5, color=WHITE)
    shape_text(rect(s, 630, 355, 275, 130, GRAY, MSO_SHAPE.ROUNDED_RECTANGLE),
               "潜在影响\n\v语义相关但无直接链接\v模型辅助判断 + 人工确认", size=12.5, color=WHITE)


def s10_boundary(prs):
    s = add_slide(prs, "人机边界：自动化分级与强制闸门")
    add_table(s, [
        ["等级", "名称", "Agent 权限", "人工角色"],
        ["A0", "辅助", "生成草案、检索、检查", "人完成全部决策与实现"],
        ["A1", "受控半自动", "生成+验证+自动修复，闸门前停", "人批闸门、终审"],
        ["A2", "受限全自动", "闸门由规则自动放行（标准项目）", "人仅例外介入、抽查"],
        ["A3", "学习型全自动", "运维优化提案自动进入闭环", "人治理知识库与规则"],
    ], 40, 100, 880, size=12)
    textbox(s, 40, 330, 880, 120, "\n".join([
        "▪ 6 项不可移除闸门：需求基线确认 ｜ 方案评审 ｜ SIL 功能认证工程师终审 ｜ 现场首次上电/带能动作 ｜ 验收签字 ｜ 生产在线变更部署",
        "▪ 危险操作（上电/带能/在线强制变量/安全程序修改）在任何等级下都是人工闸门，不随等级放开",
    ]), size=13.5)


def s11_safety(prs):
    s = add_slide(prs, "安全、合规与业务连续性")
    textbox(s, 40, 100, 880, 160, "\n".join([
        "▪ 功能安全：IEC 61511（过程）/ ISO 13849、IEC 62061（机械）——Agent 仅出草案与初查，认证决策由人负责",
        "▪ 网络安全：IEC 62443 分区与纵深防御；Agent 生成程序/组态遵循 IEC 62443-4-1 安全开发生命周期",
        "▪ 权限最小化：工程区读写、生产网只读、在线写入需审批；全量决策日志加密存证、可导出审计包",
        "▪ 责任划分：Agent 负责生成与自验证，人类闸门负责放行决策，事故追溯以日志为证据链",
    ]), size=14)
    shape_text(rect(s, 40, 290, 880, 180, BLUE, MSO_SHAPE.ROUNDED_RECTANGLE),
               "灾难恢复（示例目标，按企业校准）\n\v▪ 编排器/闸门主备部署，任务状态持久化\v▪ 工程资产多副本+异地备份：RPO≤24h、RTO≤4h\v▪ 模型中断降级：关键验证器本地化、模型多路冗余\v▪ 恢复演练每季度一次",
               size=13, color=WHITE)


def s12_knowledge(prs):
    s = add_slide(prs, "数据与知识层：冷启动策略")
    textbox(s, 40, 100, 880, 110, "\n".join([
        "▪ 标准库（GB/IEC/ISO/VDI 结构化条款）＋ 模板库（程序框架/画面规范/文档模板）＋ 案例库（历史项目/失败-修复对/现场变更）",
        "▪ 检索结果必须带出处与版本；命中率低的领域标记“知识空白”，触发补库任务",
    ]), size=14)
    shape_text(rect(s, 40, 240, 275, 230, BLUE, MSO_SHAPE.ROUNDED_RECTANGLE),
               "① 种子库构建\n\v历史项目提取 ≥20 个已验证程序模板\v≥5 套标准检查清单\v≥10 个典型案例（含失败-修复对）",
               size=12, color=WHITE)
    shape_text(rect(s, 335, 240, 275, 230, BLUE2, MSO_SHAPE.ROUNDED_RECTANGLE),
               "② 最小可用规模\n\v模板库 ≥20 条、案例库 ≥30 条\v标准库覆盖主营业务\v低于规模 → 退化为纯生成模式并显式标示",
               size=12, color=WHITE)
    shape_text(rect(s, 630, 240, 275, 230, BLUE3, MSO_SHAPE.ROUNDED_RECTANGLE),
               "③ 质量门控\n\v初始入库：资深工程师逐条审核\v后续增量：学习管线初筛 + 人工抽检（≥20%）",
               size=12, color=WHITE)


def s13_tech(prs):
    s = add_slide(prs, "关键使能技术")
    textbox(s, 40, 100, 880, 280, "\n".join([
        "▪ 模型：通用大模型 + 领域微调；结构化元数据强制 JSON Schema 校验，代码/图纸由确定性验证器裁决",
        "▪ 多模态：图纸理解（电气图/P&ID）、现场照片诊断、界面截图理解；关键结论必须附证据",
        "▪ 确定性验证引擎：编译 / Lint / E-CAD 规则 / 仿真 / 规范检查；“无可自动化接口的验证环节宁可人工，不可假自动”",
        "▪ 工具协议：MCP/A2A 能力总线封装 TIA Openness、CODESYS、TwinCAT、E-CAD、OPC UA；云端编排 + 边缘执行（离线可用）",
        "▪ 模型治理：每次生成记录模型/提示词版本；模型升级触发回归验证（最近 N 个交付项目重新编译/仿真）；提示词变更走变更审批",
    ]), size=14)


def s14_roadmap(prs):
    s = add_slide(prs, "落地路径：四阶段渐进")
    stages = [
        ("阶段一 · AI 助手", "A0→A1 起步 · 1-2 季度\n\v程序单点 + 本地编译内环\v退出：首生成编译 ≥80%"),
        ("阶段二 · 受控半自动", "A1 · 2-4 季度\n\v全链工具 + 闸门体系 + 追溯库\v退出：缺陷密度较基线 -30%"),
        ("阶段三 · 受限全自动", "A2 · 标准产线试点\n\v规则化闸门自动放行 + 人工抽查\v退出：闸门外介入 ≤2 次/项目"),
        ("阶段四 · 学习型全自动", "A3 · 运行闭环接通\n\v学习管线常态化、扩展行业\v退出：周期 -40% 持续两季度"),
    ]
    for idx, (title, body) in enumerate(stages):
        x = 20 + idx * 235
        fill = BLUE2 if idx % 2 == 0 else BLUE3
        shape_text(rect(s, x, 110, 215, 240, fill, MSO_SHAPE.ROUNDED_RECTANGLE),
                   title + "\n\v" + body, size=11.5, color=WHITE, bold=True)
        if idx < 3:
            arrow(s, x + 215, 220, 20, 26)
    textbox(s, 40, 390, 880, 60,
            "铁律：先单点后全链 · 先离线后在线 · 先低风险后高风险；任何阶段出现安全/重大质量事故即整体降级复盘",
            size=14, color=ORANGE, bold=True, align=PP_ALIGN.CENTER)


def s15_cost(prs):
    s = add_slide(prs, "成本模型与 ROI（示例口径，立项前须按企业实际重算）")
    add_table(s, [
        ["初始投入（CAPEX）", "估算", "年度收益（10 项目/年）", "估算"],
        ["Agent 平台开发/集成", "¥80-150 万", "工程人力节省（40%）", "¥60-100 万/年"],
        ["工程软件许可（TIA/EPLAN）", "¥20-50 万", "现场调试工时节省（50%）", "¥20-40 万/年"],
        ["算力与基础设施", "¥10-30 万", "质量成本降低（返工减少）", "¥10-20 万/年"],
        ["培训与变革管理", "¥5-15 万", "知识复用边际成本递减", "逐年递增"],
        ["合计", "¥115-245 万", "投资回收期", "约 1.5-2.5 年"],
    ], 40, 110, 880, size=12.5)
    textbox(s, 40, 330, 880, 50,
            "注：收益换算系数（人力等效、返工率）需按企业人力成本与订单结构校准",
            size=12, color=GRAY)


def s16_kpi(prs):
    s = add_slide(prs, "评价指标与风险对策")
    add_table(s, [
        ["核心指标", "目标（示例基线）", "核心指标", "目标"],
        ["首次生成编译通过率", "A1 ≥ 80%", "现场调试工时比", "下降 ≥ 50%"],
        ["含内环修复后编译通过率", "A1 ≥ 95%", "一次验收通过率", "≥ 80%"],
        ["虚拟调试缺陷密度", "较 3 年人工基线 -30%", "模板复用率", "≥ 60%"],
        ["闸门外人工介入", "≤ 2 次/项目", "项目周期缩短率", "≥ 40%"],
        ["追溯覆盖率", "100%", "安全事故数", "0（红线）"],
    ], 40, 100, 880, size=11.5)
    textbox(s, 40, 320, 880, 110, "\n".join([
        "▪ 主要风险对策：幻觉→确定性门禁+证据强制；接口封闭→可自动化接口为硬条件；知识库污染→初筛+人工抽检；信任崩塌→分级降级复盘",
        "▪ 首次生成 80% 基线参考 Agents4PLC 公开结果（首生成 70–85%，多轮修复后 95%+）",
    ]), size=13)


def s17_end(prs):
    s = add_slide(prs, "总结与下一步")
    shape_text(rect(s, 40, 100, 880, 60, BLUE, MSO_SHAPE.ROUNDED_RECTANGLE),
               "模型生成 · 系统裁决 · 人类把关", size=18, color=WHITE, bold=True, align=PP_ALIGN.CENTER)
    textbox(s, 40, 190, 880, 180, "\n".join([
        "▪ 唯一覆盖“全程”的闭环设计：业界实现（Eigen/SemaPLC/Agents4PLC）均只覆盖中段，本架构覆盖需求→运维 7 段",
        "▪ 三层闭环：工程环（内环修复+外环升级）+ 运行环（现场反哺）+ 学习环（经验沉淀）",
        "▪ 全自动可审计：A0–A3 分级 + 不可移除闸门 + 全量决策日志",
        "▪ 落地对标：Eigen 为商用标杆、SemaPLC/Agents4PLC 为组件与基准来源",
    ]), size=14)
    textbox(s, 40, 400, 880, 100, "\n".join([
        "v2.0 候选：组织变革转型路径 ｜ 供应商评估矩阵 ｜ 跨厂商迁移策略 ｜ 性能与扩展性 ｜ 行业垂直化适配 ｜ FAT/SAT/VAT 详细策略",
        "参考：Eigen（automation.com）· Agents4PLC（arXiv:2410.14209）· SemaPLC（github.com/midea-ai/SemaPLC）· RealPLC（TIA Openness 闭环）",
    ]), size=12, color=GRAY)


SLIDES = [s01_cover, s02_summary, s03_problem, s04_loops, s05_layers, s06_gate,
          s07_agents, s08_loops_mech, s09_trace, s10_boundary, s11_safety,
          s12_knowledge, s13_tech, s14_roadmap, s15_cost, s16_kpi, s17_end]


def build(path):
    prs = Presentation()
    prs.slide_width = P(960)
    prs.slide_height = P(540)
    for fn in SLIDES:
        fn(prs)
    prs.save(path)
    return len(prs.slides._sldIdLst)


if __name__ == "__main__":
    n = len(SLIDES)
    build(OUT)
    print("PPTX SAVED:", OUT, "| slides:", n)
