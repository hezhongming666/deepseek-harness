# -*- coding: utf-8 -*-
"""将 v1.1 架构文档生成 PPT 汇报材料（PowerPoint COM，16:9）。"""
import datetime
import win32com.client

OUT = r"D:\Tools\deepseek-harness\design-proposals\工业自动化AI-Agent闭环架构-v1.1.pptx"

# 颜色（OLE: 0xBBGGRR）
def RGB(r, g, b):
    return r | (g << 8) | (b << 16)

DARK   = RGB(15, 42, 74)      # 深海军蓝
BLUE   = RGB(31, 56, 100)
BLUE2  = RGB(47, 84, 150)
BLUE3  = RGB(68, 114, 196)
BLUE4  = RGB(142, 170, 219)
BLUE5  = RGB(189, 204, 231)
ACCENT = RGB(0, 120, 212)
ORANGE = RGB(192, 80, 40)
WHITE  = RGB(255, 255, 255)
BLACK  = RGB(30, 30, 30)
GRAY   = RGB(89, 89, 89)
LIGHT  = RGB(243, 246, 250)
GOLD   = RGB(255, 217, 102)

FONT = "微软雅黑"

def set_range(tr, size=14, bold=False, color=BLACK, font=FONT):
    tr.Font.Size = size
    tr.Font.Bold = -1 if bold else 0
    tr.Font.Color.RGB = color
    tr.Font.Name = font
    try:
        tr.Font.NameFarEast = font
    except Exception:
        pass

def add_shape(slide, stype, l, t, w, h, text="", fill=DARK, fcolor=WHITE,
              size=12, bold=False, anchor=3, line_hidden=True):
    sp = slide.Shapes.AddShape(stype, l, t, w, h)
    if fill is not None:
        sp.Fill.ForeColor.RGB = fill
        sp.Fill.Visible = -1
    if line_hidden:
        sp.Line.Visible = 0
    tf = sp.TextFrame
    tf.WordWrap = -1
    tf.VerticalAnchor = anchor
    if text:
        tr = tf.TextRange
        tr.Text = text
        set_range(tr, size, bold, fcolor)
    return sp

def add_text(slide, lines, l, t, w, h, size=14, color=BLACK, bold=False, align=1):
    tb = slide.Shapes.AddTextbox(1, l, t, w, h)
    tf = tb.TextFrame
    tf.WordWrap = -1
    tr = tf.TextRange
    tr.Text = "\r".join(lines)
    set_range(tr, size, bold, color)
    tr.ParagraphFormat.Alignment = align
    try:
        tr.ParagraphFormat.SpaceWithin = 1.12
    except Exception:
        pass
    return tb

def add_table(slide, data, l, t, w, size=11):
    rows, cols = len(data), len(data[0])
    shp = slide.Shapes.AddTable(rows, cols, l, t, w, 20 * rows)
    tbl = shp.Table
    for r, row in enumerate(data):
        for c, val in enumerate(row):
            cell = tbl.Cell(r + 1, c + 1)
            cell.Shape.Fill.Visible = -1
            tr = cell.Shape.TextFrame.TextRange
            tr.Text = val
            set_range(tr, size, bold=(r == 0), color=(WHITE if r == 0 else BLACK))
            if r == 0:
                cell.Shape.Fill.ForeColor.RGB = BLUE
            else:
                cell.Shape.Fill.ForeColor.RGB = LIGHT if r % 2 == 0 else WHITE
            try:
                cell.Shape.TextFrame.WordWrap = -1
            except Exception:
                pass
            try:
                cell.Shape.TextFrame.MarginTop = 2
                cell.Shape.TextFrame.MarginBottom = 2
            except Exception:
                pass
    return shp

def add_slide(pres, title, sub=""):
    s = pres.Slides.Add(pres.Slides.Count + 1, 12)  # ppLayoutBlank
    add_shape(s, 1, 0, 0, 960, 66, "", DARK)                 # 顶栏
    add_text(s, [title], 30, 12, 880, 46, size=21, color=WHITE, bold=True)
    add_shape(s, 1, 0, 66, 960, 4, "", ACCENT)               # 强调线
    if sub:
        add_text(s, [sub], 30, 80, 900, 30, size=12, color=GRAY)
    return s

def arrow(slide, l, t, w=34, h=26):
    return add_shape(slide, 33, l, t, w, h, "", ACCENT)      # msoShapeRightArrow

app = win32com.client.DispatchEx("PowerPoint.Application")
try:
    app.Visible = 1
    pres = app.Presentations.Add()
    pres.PageSetup.SlideWidth = 960
    pres.PageSetup.SlideHeight = 540

    # ---- S1 封面 ----
    s = pres.Slides.Add(pres.Slides.Count + 1, 12)
    add_shape(s, 1, 0, 0, 960, 540, "", DARK)
    add_shape(s, 1, 0, 300, 960, 4, "", ACCENT)
    add_text(s, ["工业自动化生产系统工程落地之",
                 "全程 AI Agent 全自动自主完成闭环设计架构"],
             60, 120, 840, 150, size=30, color=WHITE, bold=True, align=1)
    add_text(s, ["模型生成 · 系统裁决 · 人类把关"],
             60, 290, 840, 50, size=20, color=GOLD, bold=True, align=1)
    add_text(s, ["架构设计 v1.1 · 汇报版",
                 "覆盖：需求 → 设计 → 实现 → 仿真 → 现场 → 验收 → 运维 全生命周期",
                 "导出日期：" + datetime.date.today().isoformat()],
             60, 400, 840, 90, size=13, color=RGB(200, 210, 225), align=1)

    # ---- S2 执行摘要 ----
    s = add_slide(pres, "执行摘要（面向决策层）")
    add_text(s, [
        "▪ 问题：工业自动化项目交付周期长、依赖个人经验、知识复用率低",
        "▪ 方案：多 Agent 体系 + \u201c验证即门禁\u201d，需求→设计→编程→仿真→部署→运维全链路自主闭环",
        "▪ 核心原则：模型负责生成，确定性工具负责裁决，人类负责把关",
        "▪ 预期收益：项目周期 -40% 以上，现场调试工时 -50% 以上，知识复用率 ≥60%",
        "▪ 落地路径：四阶段渐进（助手→受控半自动→受限全自动→学习型全自动）",
        "▪ 投资估算（示例）：¥115–245 万初始投入，1.5–2.5 年回收（10 项目/年规模）",
    ], 40, 100, 880, 240, size=15)
    add_text(s, [
        "红 线：安全事故数为 0 ｜ SIL3+ 安全功能不自动生成 ｜ 危险操作永远人工闸门",
    ], 40, 380, 880, 50, size=16, color=ORANGE, bold=True)

    # ---- S3 问题与目标 ----
    s = add_slide(pres, "问题与目标：让 Agent 成为\u201c工程主体\u201d")
    add_shape(s, 5, 40, 110, 420, 200, "传统痛点\n\u000b周期长、高度依赖资深工程师个人经验\u000b需求变更与现场调试反复迭代\u000b知识沉淀差、复用率低",
              RGB(120, 40, 40), WHITE, 14)
    arrow(s, 470, 190)
    add_shape(s, 5, 520, 110, 420, 200, "架构目标\n\u000b以可验证、可追溯、可回滚的方式\u000b自主完成需求→运维全程闭环\u000b经验沉淀为随项目增长的学习闭环",
              RGB(15, 90, 60), WHITE, 14)
    add_text(s, [
        "▪ 质量由确定性验证器强制把关，而非依赖模型自觉",
        "▪ 人工介入收敛为预先声明的\u201c闸门\u201d，全部留痕可审计",
        "▪ 范围排除：SIL3+ 自动生成、特种设备自动签批、强物理交互全自主",
    ], 40, 340, 880, 130, size=14)

    # ---- S4 三闭环总览 ----
    s = add_slide(pres, "总体架构：三闭环嵌套")
    add_shape(s, 5, 30, 130, 280, 170,
              "工程闭环（主体）\n\u000b需求→设计→实现→验证→交付\u000b自动化程度逐级提升", BLUE, WHITE, 14)
    arrow(s, 320, 195)
    add_shape(s, 5, 370, 130, 280, 170,
              "运行闭环（反哺）\n\u000b生产数据→诊断/优化→再部署\u000b现场数据反哺工程", BLUE2, WHITE, 14)
    arrow(s, 660, 195)
    add_shape(s, 5, 710, 130, 220, 170,
              "学习闭环（增强）\n\u000b经验→案例/模板/标准库\u000b随项目增长而增强", BLUE3, WHITE, 14)
    add_text(s, [
        "▪ 工程闭环是主体：每阶段产出经确定性验证器放行（验证即门禁）",
        "▪ 运行闭环把生产现场数据回灌设计；学习闭环把项目经验沉淀复用",
    ], 40, 340, 880, 120, size=14)

    # ---- S5 分层架构 ----
    s = add_slide(pres, "总体架构：六层分层")
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
        add_shape(s, 1, 40, y, 880, 60, name + "\n\u000b" + desc, fill, fcolor, 12, bold=False)
        y += 68

    # ---- S6 验证即门禁 ----
    s = add_slide(pres, "核心机制：验证即门禁（Verify-as-Gate）")
    add_shape(s, 5, 40, 100, 880, 44,
              "生成 → 验证 → 放行 / 驳回        （确定性验证器裁决，不依赖模型自觉）", BLUE, WHITE, 15)
    add_table(s, [
        ["专业域", "验证器示例", "输出证据"],
        ["控制程序", "PLC 编译 / Lint（命名、未用变量、禁止指令）", "编译日志、Lint 报告"],
        ["电气设计", "E-CAD 规则检查（短路、未连接端子、物料校验）", "规则检查报告"],
        ["需求", "完整性 + 一致性 + 可测性检查", "追溯矩阵、缺口报告"],
        ["仿真", "数字孪生虚拟调试用例（节拍/联锁/报警/故障注入）", "通过率、时序数据"],
        ["安全", "IEC 61511 / ISO 13849 / IEC 62061 条款初查", "符合性初查表（人工终审）"],
        ["网络", "IEC 62443 分区检查、未授权端口清单", "配置审计报告"],
    ], 40, 165, 880, size=11.5)
    add_text(s, ["双 Agent 交叉评审仅作辅助证据，不替代确定性验证器；安全关键逻辑可引入形式化验证（nuXmv/PLCverif）"],
             40, 400, 880, 60, size=13, color=GRAY)

    # ---- S7 Agent 体系 ----
    s = add_slide(pres, "Agent 体系：9 个专业 Agent + 编排器")
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
        add_shape(s, 5, x, y, 290, 80, name, BLUE2, WHITE, 13, bold=True, anchor=3)
        add_shape(s, 1, x, y + 32, 290, 44, desc, LIGHT, BLACK, 10.5, anchor=3)
    add_shape(s, 5, 25, 400, 910, 70,
              "编排器 Orchestrator：DAG 任务分解 · 调度与失败升级 · 多项目隔离（无权批准闸门）", BLUE, WHITE, 13)

    # ---- S8 闭环机制 ----
    s = add_slide(pres, "闭环机制：内环 / 外环 / 学习环")
    add_shape(s, 5, 30, 105, 290, 210,
              "内闭环 · 自动修复\n\u000b生成 → 验证 fail → 诊断 → 修复 → 重验\u000b重试默认 ≤3 次，超出即升级\u000b修复以验证器输出为依据", BLUE, WHITE, 12.5)
    add_shape(s, 5, 335, 105, 290, 210,
              "外闭环 · 人工介入\n\u000b升级包必含：上下文 + 产物与证据\u000b+ 失败原因 + 候选方案\u000b裁决回写状态机并成为学习样本", BLUE2, WHITE, 12.5)
    add_shape(s, 5, 640, 105, 290, 210,
              "学习闭环 · 经验沉淀\n\u000b通过产物→模板库；失败-修复对→案例库\u000b人工裁决→规则库；现场变更→变更案例库\u000b学习管线初筛 + 人工定期审核", BLUE3, WHITE, 12.5)
    add_text(s, ["三环贯通：内环保质量，外环保可控，学习环让体系随项目数量增长而增强"],
             30, 360, 900, 60, size=15, bold=True, align=1)

    # ---- S9 追溯与变更影响 ----
    s = add_slide(pres, "全链路可追溯 + 变更影响分析")
    add_text(s, [
        "▪ 四库联动、单一数据源：需求库 / 工程资产仓库 / 追溯库 / 验证证据库，以需求 ID 贯通全程",
        "▪ 资产即代码：图纸/程序/组态/测试全部版本化，Agent 一切修改可 diff、可回滚",
        "▪ 每次生成记录：输入版本、模型与提示词版本、验证证据、Agent/人身份、时间戳",
    ], 40, 100, 880, 140, size=14)
    add_shape(s, 5, 40, 280, 880, 60,
              "变更影响分析（有向图遍历）\u000b需求节点→设计节点→实现节点→测试节点，变更沿图正向遍历下游可达节点", BLUE, WHITE, 13)
    add_shape(s, 5, 40, 355, 275, 130,
              "直接影响\n\u000b同一节点产物需重新生成\u000b自动触发重新生成+验证", ORANGE, WHITE, 12.5)
    add_shape(s, 5, 335, 355, 275, 130,
              "间接影响\n\u000b下游节点需重新验证\u000b进入待办队列", BLUE2, WHITE, 12.5)
    add_shape(s, 5, 630, 355, 275, 130,
              "潜在影响\n\u000b语义相关但无直接链接\u000b模型辅助判断 + 人工确认", GRAY, WHITE, 12.5)

    # ---- S10 人机边界 ----
    s = add_slide(pres, "人机边界：自动化分级与强制闸门")
    add_table(s, [
        ["等级", "名称", "Agent 权限", "人工角色"],
        ["A0", "辅助", "生成草案、检索、检查", "人完成全部决策与实现"],
        ["A1", "受控半自动", "生成+验证+自动修复，闸门前停", "人批闸门、终审"],
        ["A2", "受限全自动", "闸门由规则自动放行（标准项目）", "人仅例外介入、抽查"],
        ["A3", "学习型全自动", "运维优化提案自动进入闭环", "人治理知识库与规则"],
    ], 40, 100, 880, size=12)
    add_text(s, [
        "▪ 6 项不可移除闸门：需求基线确认 ｜ 方案评审 ｜ SIL 功能认证工程师终审 ｜ 现场首次上电/带能动作 ｜ 验收签字 ｜ 生产在线变更部署",
        "▪ 危险操作（上电/带能/在线强制变量/安全程序修改）在任何等级下都是人工闸门，不随等级放开",
    ], 40, 330, 880, 120, size=13.5)

    # ---- S11 安全合规与灾难恢复 ----
    s = add_slide(pres, "安全、合规与业务连续性")
    add_text(s, [
        "▪ 功能安全：IEC 61511（过程）/ ISO 13849、IEC 62061（机械）——Agent 仅出草案与初查，认证决策由人负责",
        "▪ 网络安全：IEC 62443 分区与纵深防御；Agent 生成程序/组态遵循 IEC 62443-4-1 安全开发生命周期",
        "▪ 权限最小化：工程区读写、生产网只读、在线写入需审批；全量决策日志加密存证、可导出审计包",
        "▪ 责任划分：Agent 负责生成与自验证，人类闸门负责放行决策，事故追溯以日志为证据链",
    ], 40, 100, 880, 160, size=14)
    add_shape(s, 5, 40, 290, 880, 180,
              "灾难恢复（示例目标，按企业校准）\n\u000b▪ 编排器/闸门主备部署，任务状态持久化\u000b▪ 工程资产多副本+异地备份：RPO≤24h、RTO≤4h\u000b▪ 模型中断降级：关键验证器本地化、模型多路冗余\u000b▪ 恢复演练每季度一次", BLUE, WHITE, 13)

    # ---- S12 数据与知识层 ----
    s = add_slide(pres, "数据与知识层：冷启动策略")
    add_text(s, [
        "▪ 标准库（GB/IEC/ISO/VDI 结构化条款）＋ 模板库（程序框架/画面规范/文档模板）＋ 案例库（历史项目/失败-修复对/现场变更）",
        "▪ 检索结果必须带出处与版本；命中率低的领域标记\u201c知识空白\u201d，触发补库任务",
    ], 40, 100, 880, 110, size=14)
    add_shape(s, 5, 40, 240, 275, 230,
              "① 种子库构建\n\u000b历史项目提取 ≥20 个已验证程序模板\u000b≥5 套标准检查清单\u000b≥10 个典型案例（含失败-修复对）", BLUE, WHITE, 12)
    add_shape(s, 5, 335, 240, 275, 230,
              "② 最小可用规模\n\u000b模板库 ≥20 条、案例库 ≥30 条\u000b标准库覆盖主营业务\u000b低于规模 → 退化为纯生成模式并显式标示", BLUE2, WHITE, 12)
    add_shape(s, 5, 630, 240, 275, 230,
              "③ 质量门控\n\u000b初始入库：资深工程师逐条审核\u000b后续增量：学习管线初筛 + 人工抽检（≥20%）", BLUE3, WHITE, 12)

    # ---- S13 关键使能技术 ----
    s = add_slide(pres, "关键使能技术")
    add_text(s, [
        "▪ 模型：通用大模型 + 领域微调；结构化元数据强制 JSON Schema 校验，代码/图纸由确定性验证器裁决",
        "▪ 多模态：图纸理解（电气图/P&ID）、现场照片诊断、界面截图理解；关键结论必须附证据",
        "▪ 确定性验证引擎：编译 / Lint / E-CAD 规则 / 仿真 / 规范检查；\u201c无可自动化接口的验证环节宁可人工，不可假自动\u201d",
        "▪ 工具协议：MCP/A2A 能力总线封装 TIA Openness、CODESYS、TwinCAT、E-CAD、OPC UA；云端编排 + 边缘执行（离线可用）",
        "▪ 模型治理：每次生成记录模型/提示词版本；模型升级触发回归验证（最近 N 个交付项目重新编译/仿真）；提示词变更走变更审批",
    ], 40, 100, 880, 280, size=14)

    # ---- S14 落地路径 ----
    s = add_slide(pres, "落地路径：四阶段渐进")
    stages = [
        ("阶段一 · AI 助手", "A0→A1 起步 · 1-2 季度\n\u000b程序单点 + 本地编译内环\u000b退出：首生成编译 ≥80%"),
        ("阶段二 · 受控半自动", "A1 · 2-4 季度\n\u000b全链工具 + 闸门体系 + 追溯库\u000b退出：缺陷密度较基线 -30%"),
        ("阶段三 · 受限全自动", "A2 · 标准产线试点\n\u000b规则化闸门自动放行 + 人工抽查\u000b退出：闸门外介入 ≤2 次/项目"),
        ("阶段四 · 学习型全自动", "A3 · 运行闭环接通\n\u000b学习管线常态化、扩展行业\u000b退出：周期 -40% 持续两季度"),
    ]
    for idx, (title, body) in enumerate(stages):
        x = 20 + idx * 235
        add_shape(s, 5, x, 110, 215, 240, title + "\n\u000b" + body, BLUE2 if idx % 2 == 0 else BLUE3, WHITE, 11.5, bold=True)
        if idx < 3:
            arrow(s, x + 215, 220, 20, 26)
    add_text(s, [
        "铁律：先单点后全链 · 先离线后在线 · 先低风险后高风险；任何阶段出现安全/重大质量事故即整体降级复盘",
    ], 40, 390, 880, 60, size=14, color=ORANGE, bold=True, align=1)

    # ---- S15 成本与 ROI ----
    s = add_slide(pres, "成本模型与 ROI（示例口径，立项前须按企业实际重算）")
    add_table(s, [
        ["初始投入（CAPEX）", "估算", "年度收益（10 项目/年）", "估算"],
        ["Agent 平台开发/集成", "¥80-150 万", "工程人力节省（40%）", "¥60-100 万/年"],
        ["工程软件许可（TIA/EPLAN）", "¥20-50 万", "现场调试工时节省（50%）", "¥20-40 万/年"],
        ["算力与基础设施", "¥10-30 万", "质量成本降低（返工减少）", "¥10-20 万/年"],
        ["培训与变革管理", "¥5-15 万", "知识复用边际成本递减", "逐年递增"],
        ["合计", "¥115-245 万", "投资回收期", "约 1.5-2.5 年"],
    ], 40, 110, 880, size=12.5)
    add_text(s, ["注：收益换算系数（人力等效、返工率）需按企业人力成本与订单结构校准"],
             40, 330, 880, 50, size=12, color=GRAY)

    # ---- S16 指标与风险 ----
    s = add_slide(pres, "评价指标与风险对策")
    add_table(s, [
        ["核心指标", "目标（示例基线）", "核心指标", "目标"],
        ["首次生成编译通过率", "A1 ≥ 80%", "现场调试工时比", "下降 ≥ 50%"],
        ["含内环修复后编译通过率", "A1 ≥ 95%", "一次验收通过率", "≥ 80%"],
        ["虚拟调试缺陷密度", "较 3 年人工基线 -30%", "模板复用率", "≥ 60%"],
        ["闸门外人工介入", "≤ 2 次/项目", "项目周期缩短率", "≥ 40%"],
        ["追溯覆盖率", "100%", "安全事故数", "0（红线）"],
    ], 40, 100, 880, size=11.5)
    add_text(s, [
        "▪ 主要风险对策：幻觉→确定性门禁+证据强制；接口封闭→可自动化接口为硬条件；知识库污染→初筛+人工抽检；信任崩塌→分级降级复盘",
        "▪ 首次生成 80% 基线参考 Agents4PLC 公开结果（首生成 70–85%，多轮修复后 95%+）",
    ], 40, 320, 880, 110, size=13)

    # ---- S17 总结 ----
    s = add_slide(pres, "总结与下一步")
    add_shape(s, 5, 40, 100, 880, 60, "模型生成 · 系统裁决 · 人类把关", BLUE, WHITE, 18, bold=True, anchor=3)
    add_text(s, [
        "▪ 唯一覆盖\u201c全程\u201d的闭环设计：业界实现（Eigen/SemaPLC/Agents4PLC）均只覆盖中段，本架构覆盖需求→运维 7 段",
        "▪ 三层闭环：工程环（内环修复+外环升级）+ 运行环（现场反哺）+ 学习环（经验沉淀）",
        "▪ 全自动可审计：A0–A3 分级 + 不可移除闸门 + 全量决策日志",
        "▪ 落地对标：Eigen 为商用标杆、SemaPLC/Agents4PLC 为组件与基准来源",
    ], 40, 190, 880, 180, size=14)
    add_text(s, [
        "v2.0 候选：组织变革转型路径 ｜ 供应商评估矩阵 ｜ 跨厂商迁移策略 ｜ 性能与扩展性 ｜ 行业垂直化适配 ｜ FAT/SAT/VAT 详细策略",
        "参考：Eigen（automation.com）· Agents4PLC（arXiv:2410.14209）· SemaPLC（github.com/midea-ai/SemaPLC）· RealPLC（TIA Openness 闭环）",
    ], 40, 400, 880, 100, size=12, color=GRAY)

    pres.SaveAs(OUT, 24)  # ppSaveAsOpenXMLPresentation
    print("PPTX SAVED:", OUT)
    print("slides:", pres.Slides.Count)
    pres.Close()
finally:
    try:
        app.Quit()
    except Exception:
        pass
