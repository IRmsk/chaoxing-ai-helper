/**
 * Mock：任务流场景。
 *
 * 用一份**按真实 DOM 复刻**的任务流页面 + 附件选择器页面，验证两块最容易出错的新逻辑：
 *
 * 1. **任务流解析**：`.flow-card-list` 只渲染到当前节点，后续节点藏在
 *    「解锁下一节点条件」的 `.unlock-target`（`<p>类型</p><h4>标题</h4>`）里；
 *    节点类型文案里还夹着 `.task-index`（"02情景对话"）。
 *    这两点读错，后续的「上传 / 推进」全会跑偏。
 * 2. **附件上传**：上传节点没有 `input[type=file]`，要点「选择文件」打开
 *    超星通用附件选择器，那里才有 `input.attCommonUploadBtn`。
 *    本模块直接复刻那个选择器，验证
 *    「base64 → File → DataTransfer 写进 input → change → 勾选 → 确定」整条链路。
 */

/** 场景句柄。 */
export interface FlowScene {
  dispose(): void;
}

/** 复刻的任务流 DOM（结构与真实页面一致）。 */
export function createFlowScene(mount: HTMLElement): FlowScene {
  mount.innerHTML = `
    <div class="task-flow">
      <div class="flow-card-list">
        <article class="flow-card is-completed">
          <header class="flow-card-header">
            <div class="task-type theme-blue"><span class="task-index">01</span><span>情景对话</span></div>
            <div class="task-score"><strong>95</strong><span>分</span></div>
          </header>
          <div class="flow-card-body">
            <h3>缺陷预判</h3>
            <p>阅读项目经理提供的两段存在并发隐患的代码，分析并指出可能存在的缺陷。</p>
          </div>
          <div class="complete-condition">已完成条件：学生准确指出了线程安全问题与竞态条件风险。</div>
        </article>

        <article class="flow-card is-current is-selected">
          <header class="flow-card-header">
            <div class="task-type theme-blue"><span class="task-index">02</span><span>情景对话</span></div>
            <div class="task-status"><span class="status-dot"></span><span>当前任务</span></div>
          </header>
          <div class="flow-card-body">
            <h3>调试取证</h3>
            <p>必须详细描述调试过程，包括使用的具体调试命令、发现的异常情况，以及如何通过设置断点捕获到异常。</p>
          </div>
        </article>

        <!--
          即将作答的节点：页面对它的点击是**无效的**（selectTask 里 upcoming 直接 return），
          唯一入口是卡片上的「进入任务」按钮 —— 点它会弹出初始化提示，
          确认（「直接来吧」）后才调 taskChainInit 并把该节点刷成当前节点。
        -->
        <article class="flow-card is-upcoming">
          <header class="flow-card-header">
            <div class="task-type theme-blue"><span class="task-index">03</span><span>情景对话</span></div>
            <div class="task-status task-status--upcoming"><span class="status-dot status-dot--upcoming"></span><span>即将作答</span></div>
          </header>
          <div class="flow-card-body">
            <h3>终局方案评审</h3>
            <p>向专家汇报最终修复方案，回答关于边界条件的追问。</p>
          </div>
          <button type="button" class="flow-card-enter-btn"> 进入任务 </button>
        </article>

        <span class="line"></span>

        <div class="unlock-condition">
          <div class="unlock-condition-title">解锁下一节点条件：</div>
          <div class="unlock-condition-list">
            <div class="unlock-condition-row">
              <div class="unlock-rule">学生提供了合理的断点设置说明，并正确解释了观察到的线程异常现象。</div>
              <div class="link-container"></div>
              <div class="unlock-target"><p>上传作品</p><h4>假设验证与修复</h4></div>
            </div>
            <div class="unlock-condition-row">
              <div class="unlock-rule">学生描述的调试方法无效或对异常现象的解释不符合并发原理。</div>
              <div class="link-container"></div>
              <div class="unlock-target"><p>情景对话</p><h4>调试取证</h4></div>
            </div>
          </div>
        </div>
      </div>

      <div class="right-content">
        <div class="upload-content">
          <section class="upload-work">
            <div class="upload-card">
              <div class="task-detail">
                <h3>假设验证与修复</h3>
                <p>针对前面的并发缺陷，给出修复方案，并说明验证过程。</p>
              </div>
            </div>
            <div class="upload-card">
              <div class="work-panel">
                <h3>修复方案说明文档</h3>
                <div class="work-meta"><span>类型：文档</span><i></i><span>数量：1</span></div>
                <p>请提交一份 .docx，包含问题定位、修复思路、验证结果三部分。</p>
                <div class="uploaded-files" style="display:none"></div>
              </div>
              <button type="button" class="choose-btn"><span>选择文件</span></button>
              <button type="button" class="start-eval-btn"><span>开始评估</span></button>
            </div>
          </section>
        </div>
      </div>

      <!--
        初始化提示弹窗（复刻真实页面的 .init-dialog）。
        真实页面里确认按钮的文案是「直接来吧」，点它会调 taskChainInit 接口，
        之后任务流刷新、即将作答的节点才变成当前节点。
      -->
      <div class="init-dialog-mask" style="display:none">
        <div class="init-dialog">
          <div class="init-dialog__header">
            <span class="init-dialog__title">提示</span>
            <button type="button" class="init-dialog__close">×</button>
          </div>
          <div class="init-dialog__body"><p>即将进入新的任务节点，是否继续？</p></div>
          <div class="init-dialog__footer">
            <button type="button" class="init-dialog__btn init-dialog__btn--secondary"> 我再想想 </button>
            <button type="button" class="init-dialog__btn init-dialog__btn--primary"> 直接来吧 </button>
          </div>
        </div>
      </div>
    </div>
  `;
  wireUpcomingNode(mount);
  return { dispose: () => void (mount.innerHTML = '') };
}

/**
 * 接线「即将作答」节点的进入流程（复刻真实页面的行为）。
 *
 * @param mount 场景根节点。
 */
function wireUpcomingNode(mount: HTMLElement): void {
  const card = mount.querySelector<HTMLElement>('.flow-card.is-upcoming');
  const mask = mount.querySelector<HTMLElement>('.init-dialog-mask');
  const enterBtn = mount.querySelector<HTMLElement>('.flow-card-enter-btn');
  const primary = mount.querySelector<HTMLElement>('.init-dialog__btn--primary');
  const secondary = mount.querySelector<HTMLElement>('.init-dialog__btn--secondary');
  if (!card || !mask || !enterBtn || !primary || !secondary) return;

  // 点卡片本身：真实页面里 upcoming 会被忽略 —— mock 保持「无反应」
  card.addEventListener('click', () => {
    /* 刻意什么都不做，复刻真实行为 */
  });

  enterBtn.addEventListener('click', () => {
    mask.style.display = 'flex'; // 复刻 handleUpcomingTaskClick → showInitDialog = true
  });

  secondary.addEventListener('click', () => {
    mask.style.display = 'none';
  });

  primary.addEventListener('click', () => {
    // 复刻 handleInitConfirm：调 taskChainInit → 刷新任务流 → 该节点变当前节点
    mask.style.display = 'none';
    card.classList.remove('is-upcoming');
    card.classList.add('is-current', 'is-selected');
    const status = card.querySelector('.task-status');
    if (status) status.textContent = '当前任务';

    const right = mount.querySelector('.right-content');
    if (right) right.innerHTML = '<iframe class="dialogue-frame" src="about:blank"></iframe>';
  });
}

/**
 * 复刻附件选择器页面（`/mooc2-ans/attCommon/s` 的关键部分）。
 *
 * 关键行为：点「确定」时页面把**已提交的附件列表** `postMessage` 给宿主；
 * 这里把它替换成一个可断言的记录点。
 *
 * ## 真机结构（2026-09 CDP 实测，1:1 还原）
 *
 * 页面上有**两张结构完全不同的表**，这一点是上传失败的关键：
 *
 * | 表 | 表头 | 有勾选列？ |
 * | --- | --- | --- |
 * | 本地上传（`el-table_2_*`） | 文件名 / 大小 / 状态 / 操作 | ❌ **没有** |
 * | 云盘（`el-table_1_*`） | ☑ / 文件名 / 大小 / 创建时间 | ✅ 有（历史行全部 `is-disabled`） |
 *
 * 由此暴露出两个真实缺陷（本场景就是为它们准备的）：
 *
 * 1. **勾选取「第一个勾选框」** → 落到云盘那些**禁用**的历史行上，点了等于没点；
 * 2. **要求必须有勾选框** → 可是我们上传的文件落在「本地上传」表里，
 *    那一行**根本没有勾选框**，页面本来就会自行带上它 ——
 *    旧实现因此永远不点「确定」，表现就是「文件传上去了，作品卡片上却没有」。
 */
export function createPickerScene(onConfirm: (payload: string) => void): FlowScene {
  const host = document.createElement('div');
  host.id = 'attCommonApp';
  host.className = 'attCommon';
  host.innerHTML = `
    <div class="modal add-attachment">
      <div class="modal-cont modal640">
        <div class="modal-title flex"><p>添加附件</p></div>
        <div class="h470">
          <div class="tab-box">
            <div class="tab-item active">本地上传</div>
            <div class="tab-item">云盘</div>
          </div>
          <div class="tab-con">
            <div class="upload-box">
              <div class="tips">将文件拖拽至此区域</div>
              <input type="file" accept=".doc,.docx,image/png,image/jpeg" title="选择本地文件" class="attCommonUploadBtn" />
              <div class="modal-btn"><p class="sure">选择本地文件</p></div>
            </div>
            <div class="local-table">
              <div class="el-table__body-wrapper">
                <table class="el-table__body">
                  <thead><tr><th>文件名</th><th>大小</th><th>状态</th><th>操作</th></tr></thead>
                  <tbody class="local-rows"></tbody>
                </table>
              </div>
              <div class="modal-btn"><p class="add-more">继续添加</p></div>
            </div>
            <div class="cloud-table">
              <div class="el-table__body-wrapper">
                <table class="el-table__body">
                  <thead><tr><th></th><th>文件名</th><th>大小</th><th>创建时间</th></tr></thead>
                  <tbody class="cloud-rows"></tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-btn flex modal-btn-tip">
          <div class="flexP"></div>
          <div class="flex">
            <p class="cancel">取消</p>
            <p class="sure confirm">确定</p>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(host);

  const localRows = host.querySelector('.local-rows')!;
  const cloudRows = host.querySelector('.cloud-rows')!;
  const uploadBox = host.querySelector<HTMLElement>('.upload-box')!;

  /*
   * 真机复刻：云盘表里本来就有历史文件行，且勾选框全是禁用的。
   *
   * 旧实现「取第一个勾选框」会点到它们 —— 禁用的 input 点了不响应，
   * 于是确认时提交**空列表**（宿主实测收到 `{"type":"attachmentConfirm","data":"[]"}`）。
   */
  for (let i = 0; i < 10; i += 1) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><label class="el-checkbox is-disabled"><span class="el-checkbox__input is-disabled">
        <span class="el-checkbox__inner"></span>
        <input type="checkbox" class="el-checkbox__original" disabled="disabled" />
      </span></label></td>
      <td class="cell">云盘-历史${i + 1}.docx</td>
      <td class="cell">—</td>
      <td class="cell">—</td>`;
    cloudRows.appendChild(tr);
  }

  /**
   * 挂一个新的文件输入框。
   *
   * 真机：上传过一次之后页面会把上传框收起来，`input[type=file]` 从 DOM 消失，
   * 只留一个「继续添加」按钮 —— 所以重传必须先点它，否则永远等不到输入框。
   */
  const bindInput = (input: HTMLInputElement): void => {
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      setTimeout(() => {
        // 本地上传表：**没有勾选列**，列是 文件名 / 大小 / 状态 / 操作
        const tr = document.createElement('tr');
        tr.className = 'el-table__row';
        tr.innerHTML = `
          <td class="cell doc-name">${file.name}</td>
          <td class="cell">${Math.round(file.size / 1024)} KB</td>
          <td class="cell"><span class="success">上传成功</span></td>
          <td class="cell"></td>`;
        localRows.appendChild(tr);
        // 上传框收起，换成「继续添加」
        uploadBox.style.display = 'none';
      }, 300);
    });
  };
  bindInput(host.querySelector<HTMLInputElement>('input.attCommonUploadBtn')!);

  // 「继续添加」：把上传框重新调出来（带一个全新的 input）
  host.querySelector('.add-more')!.addEventListener('click', () => {
    const fresh = document.createElement('input');
    fresh.type = 'file';
    fresh.className = 'attCommonUploadBtn';
    fresh.setAttribute('accept', '.doc,.docx,image/png,image/jpeg');
    uploadBox.appendChild(fresh);
    uploadBox.style.display = '';
    bindInput(fresh);
  });

  // 「确定」：真机把「本地上传」表里的文件全部提交（不需要勾选）
  host.querySelector('.confirm')!.addEventListener('click', () => {
    const local = Array.from(localRows.querySelectorAll('.doc-name'))
      .map((el) => el.textContent ?? '')
      .filter(Boolean);
    const checkedCloud = Array.from(host.querySelectorAll<HTMLInputElement>('.el-checkbox__original:checked'))
      .map((b) => b.closest('tr')?.querySelector('.cell')?.textContent ?? '')
      .filter(Boolean);
    onConfirm(JSON.stringify([...local, ...checkedCloud]));
  });

  return {
    dispose() {
      host.remove();
    },
  };
}

/* ------------------------------------------------------------------ */
/* 故障复刻场景 ①：卡片标记滞留 —— 「已到上传节点却显示上一个对话节点」      */
/* ------------------------------------------------------------------ */

/**
 * 复刻线上故障：**右侧已经是「上传作品」节点，但卡片上的当前标记还滞留在
 * 上一个「情景对话」节点上**，而且新节点的 `.task-type` 还没渲染出来。
 *
 * 这是「任务流助手的节点识别也不对」的典型现场：
 * - 旧实现只读 `is-current` → 拿到的是**上一张卡片**（对话节点）；
 * - 旧实现拿 `.task-type` 判类型 → 空串 → `unknown` → 编排器当对话节点跑。
 *
 * 正确行为必须同时满足：
 * - 用「内容区标题 ⇄ 卡片标题」对号入座，定位到**第 3 个**卡片；
 * - 用内容区类型 + 卡片文案把类型校正为 `upload`。
 */
export function createStaleCurrentScene(mount: HTMLElement): FlowScene {
  mount.innerHTML = `
    <div class="task-flow">
      <div class="flow-card-list">
        <article class="flow-card is-completed">
          <header class="flow-card-header">
            <div class="task-type theme-blue"><span class="task-index">01</span><span>情景对话</span></div>
            <div class="task-score"><strong>95</strong><span>分</span></div>
          </header>
          <div class="flow-card-body">
            <h3>缺陷预判</h3>
            <p>阅读存在并发隐患的代码，分析并指出可能存在的缺陷。</p>
          </div>
        </article>

        <!-- 上一节点：前端的 is-current / is-selected 标记**滞留在它身上** -->
        <article class="flow-card is-completed is-current is-selected">
          <header class="flow-card-header">
            <div class="task-type theme-blue"><span class="task-index">02</span><span>情景对话</span></div>
            <div class="task-status"><span class="status-dot"></span><span>当前任务</span></div>
          </header>
          <div class="flow-card-body">
            <h3>调试取证</h3>
            <p>必须详细描述调试过程，包括使用的具体调试命令与发现的异常情况。</p>
          </div>
        </article>

        <!--
          真正的当前节点：上传作品。
          ⚠️ 刻意**不渲染 .task-type** —— 复刻「卡片还没渲染完整 / 站点改版去掉了该类名」。
          旧实现会把它判成 unknown，再被编排器当成对话节点跑，文件永远传不上去。
        -->
        <article class="flow-card is-current is-selected">
          <header class="flow-card-header">
            <div class="task-status"><span class="status-dot"></span><span>当前任务</span></div>
          </header>
          <div class="flow-card-body">
            <h3>假设验证与修复</h3>
            <p>请上传一份 .docx 作品，包含问题定位、修复思路、验证结果三部分。</p>
          </div>
        </article>
      </div>

      <div class="right-content">
        <div class="upload-content">
          <section class="upload-work">
            <div class="upload-card">
              <div class="task-detail">
                <h3>假设验证与修复</h3>
                <p>针对前面的并发缺陷，给出修复方案，并说明验证过程。</p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  `;
  return { dispose: () => void (mount.innerHTML = '') };
}

/* ------------------------------------------------------------------ */
/* 故障复刻场景 ②：首个节点是上传作品 —— 「被识别成对话节点」               */
/* ------------------------------------------------------------------ */

/**
 * 复刻线上故障：**第一个节点就是「上传作品」，并且 `.task-type` 读不到**。
 *
 * 旧实现：`classifyNodeType('')` → `unknown` → 编排器 `if (type === 'upload') … else 跑对话`，
 * 于是这个节点被当成对话节点去跑 —— 表现就是「第一个节点是上传 word，
 * 却被识别为对话节点，无法上传 word 文件」。
 *
 * 正确行为：类型为空时用**卡片文案 + 内容区**推断出 `upload`。
 */
export function createUploadFirstScene(mount: HTMLElement): FlowScene {
  mount.innerHTML = `
    <div class="task-flow">
      <div class="flow-card-list">
        <!-- 首个节点就是上传作品，且刻意不带 .task-type -->
        <article class="flow-card is-current is-selected">
          <header class="flow-card-header">
            <div class="task-status"><span class="status-dot"></span><span>当前任务</span></div>
          </header>
          <div class="flow-card-body">
            <h3>成果提交</h3>
            <p>请提交你的实践成果：上传一份 .docx 文档，说明你的设计思路与验证结论。</p>
          </div>
        </article>

        <!-- 后续节点：答辩类，应被推断为「情景对话」 -->
        <article class="flow-card is-upcoming">
          <header class="flow-card-header">
            <div class="task-status task-status--upcoming"><span class="status-dot status-dot--upcoming"></span><span>即将作答</span></div>
          </header>
          <div class="flow-card-body">
            <h3>终局答辩</h3>
            <p>向专家汇报最终方案，并回答关于边界条件的追问。</p>
          </div>
          <button type="button" class="flow-card-enter-btn"> 进入任务 </button>
        </article>
      </div>

      <div class="right-content">
        <div class="upload-content">
          <section class="upload-work">
            <div class="upload-card">
              <div class="task-detail">
                <h3>成果提交</h3>
                <p>提交一份 .docx，包含设计思路与验证结论。</p>
              </div>
            </div>
            <div class="upload-card">
              <div class="work-panel">
                <h3>实践成果文档</h3>
                <div class="work-meta"><span>类型：文档</span><i></i><span>数量：1</span></div>
                <p>请提交一份 .docx，不少于 500 字。</p>
              </div>
              <button type="button" class="choose-btn"><span>选择文件</span></button>
            </div>
          </section>
        </div>
      </div>
    </div>
  `;
  return { dispose: () => void (mount.innerHTML = '') };
}

/* ------------------------------------------------------------------ */
/* 故障复刻场景 ③：全部完成后的收尾（幽灵节点 / 反复啃已完成的节点）        */
/* ------------------------------------------------------------------ */

/** 完成态场景句柄（额外挂几个钩子，用于验证「收尾」这条链路）。 */
export interface FlowDoneScene extends FlowScene {
  /** 移除「任务已完成」哨兵行。 */
  removeDoneSentinel(): void;
  /** 复刻「最终评估已生成」：pending 行换成带分数的行。 */
  markFinalEvaluated(score: string): void;
}

/**
 * 复刻真机「整条任务流做完」的状态（2026-09 CDP 实测结构 1:1 还原）。
 *
 * 这里有**三个专门用来坑住旧实现的细节**：
 *
 * 1. `.flow-card-list` 末尾多出一个 `article.flow-card.flow-card--done`
 *    —— 它是「任务已完成 / 查看最终评估结果」的汇总行，**既没有 `.task-type`
 *    也没有 `h3`**。当成节点读会得到一个「类型 unknown、永远未完成」的幽灵节点，
 *    编排器以为还有活要干，永远收不了尾（面板一直显示"正在处理…"）。
 * 2. `.right-content` **仍然挂着最后一题的 `.upload-content`**（连同它的标题）
 *    —— 只按「内容区是上传节点」就临时合成节点的话，会**反复去啃一个已经做完的节点**。
 * 3. 解锁条件区最后一条是 `<p>结束</p><h4></h4>` —— **终止标记，不是节点**。
 *    把它当待解锁节点会让 `allCompleted` 永远不成立。
 */
export function createFlowDoneScene(mount: HTMLElement): FlowDoneScene {
  mount.innerHTML = `
    <div class="task-flow">
      <div class="flow-card-list">
        <article class="flow-card is-completed">
          <header class="flow-card-header">
            <div class="task-type theme-blue"><span class="task-index">01</span><span>情景对话</span></div>
            <div class="task-score"><strong>100</strong><span>分</span></div>
          </header>
          <div class="flow-card-body">
            <h3>逻辑要素梳理</h3>
            <p>向专家陈述选定的题目，并尝试列出初步的条件桩和动作桩。</p>
          </div>
        </article>

        <article class="flow-card is-completed">
          <header class="flow-card-header">
            <div class="task-type theme-orange"><span class="task-index">02</span><span>上传作品</span></div>
            <div class="task-score"><strong>97</strong><span>分</span></div>
          </header>
          <div class="flow-card-body">
            <h3>初始判定表构建</h3>
            <p>根据对话中梳理的逻辑，列出所有可能的组合，形成格式规范的完整判定表并提交。</p>
          </div>
        </article>

        <article class="flow-card is-completed">
          <header class="flow-card-header">
            <div class="task-type theme-blue"><span class="task-index">03</span><span>情景对话</span></div>
            <div class="task-score"><strong>100</strong><span>分</span></div>
          </header>
          <div class="flow-card-body">
            <h3>判定表化简研讨</h3>
            <p>向专家展示化简思路，回答专家关于规则合并的引导性提问。</p>
          </div>
        </article>

        <article class="flow-card is-completed is-selected">
          <header class="flow-card-header">
            <div class="task-type theme-orange"><span class="task-index">04</span><span>上传作品</span></div>
            <div class="task-score"><strong>96</strong><span>分</span></div>
          </header>
          <div class="flow-card-body">
            <h3>测试用例设计</h3>
            <p>依据研讨确定的简化判定表，为每一列规则设计相应的测试用例并提交。</p>
          </div>
        </article>

        <!-- ★ 哨兵行：不是节点，必须被排除 -->
        <article class="flow-card flow-card--done">
          <div class="task-done-row task-done-row--pending">
            <div class="task-done-left"><span>任务已完成</span><span>查看最终评估结果</span></div>
          </div>
        </article>

        <div class="unlock-condition">
          <div class="unlock-condition-list">
            <div class="unlock-condition-row">
              <div class="unlock-rule">学生提交的测试用例覆盖了全部规则列。</div>
              <div class="unlock-target"><p>上传作品</p><h4>测试用例设计</h4></div>
            </div>
            <!-- ★ 终止标记：p 有文案但 h4 为空，必须被排除 -->
            <div class="unlock-condition-row">
              <div class="unlock-rule">全部节点完成后结束本次实践。</div>
              <div class="unlock-target"><p>结束</p><h4></h4></div>
            </div>
          </div>
        </div>
      </div>

      <!-- ★ 最后一题的内容区仍挂着（真机如此），标题与最后一张卡片一致 -->
      <div class="right-content">
        <div class="upload-content">
          <section class="upload-work">
            <div class="upload-card">
              <div class="task-detail">
                <h3>测试用例设计</h3>
                <p>依据研讨确定的简化判定表，为每一列规则设计相应的测试用例并提交。</p>
              </div>
            </div>
            <div class="upload-card">
              <div class="work-panel">
                <h3>测试用例文档</h3>
                <div class="work-meta"><span>类型：文档</span><i></i><span>数量：1</span></div>
                <p>请提交一份 .docx。</p>
                <div class="uploaded-files"><span>测试用例设计.docx</span></div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  `;
  return {
    dispose: () => void (mount.innerHTML = ''),
    removeDoneSentinel: () => void mount.querySelector('.flow-card--done')?.remove(),
    /*
     * 复刻站点源码里 `recordStatus !== 0` 的分支：
     * `.task-done-row--pending`（查看最终评估结果）→ `.task-done-row` + `.task-done-score-num`。
     */
    markFinalEvaluated: (score: string) => {
      const row = mount.querySelector('.task-done-row');
      if (!row) return;
      row.className = 'task-done-row';
      row.innerHTML = `
        <div class="task-done-left"><span>任务已完成</span></div>
        <div class="task-done-score">
          <span class="task-done-score-label">最终评估得分：</span>
          <strong class="task-done-score-num">${score}</strong>
        </div>`;
    },
  };
}
