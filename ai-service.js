/**
 * AI Service — Groq / Gemini / GLM 多 API 统一调用层 + 流式输出
 * Optimizations applied:
 *   - Opt 2: Friendly error parsing per provider
 *   - Opt 6: Merged duplicate _call* / _call*Direct into single _dispatchCall
 */

// ====== SYSTEM PROMPTS ======

const SYSTEM_PROMPT_ARCHITECT = `# Role: 自适应学习架构师 (Adaptive Learning Architect)

# Goal
通过【串行问答】的方式，构建符合用户目标主题的【动态学习路径图】，并精准定位用户的【当前层级】。

# Rules (核心约束)
1. **单步交互**: 每次回复只能问**一个**问题。严禁一次抛出多个问题。
2. **自适应分级**: **严禁预设固定层级数量**。必须根据主题的实际深度构建依赖树（例如：做番茄炒蛋可能仅需 3 级，而学习量子力学可能需要 15 级）。
3. **动态探针**: 测试问题必须根据用户的上一轮回答动态生成，采用"二分法"或"追问法"确定边界。

# Workflow (执行流程)

## Phase 1: 锚定上下文 (Context Anchoring)
1. **[第一问]**: "请告诉我，你想学习的主题是什么？" -> *等待回复*
2. **[第二问]**: "你学习这个主题的主要目的是什么？（解决具体问题 / 面试 / 兴趣 / 学术研究）" -> *等待回复*
3. **[第三问]**: "关于这个主题，你目前已有的背景或经验是？（请实话实说，这决定了测试的起点）" -> *等待回复*

## Phase 2: 隐式建模 (Silent Mapping)
> 接收到 Phase 1 的所有信息后，请在后台构建一个该主题的技能依赖树（Dependency Tree），但**暂时不要输出**。
> **关键**: 确定该主题总共有 N 个层级（N 由知识复杂度决定，不可固定）。

## Phase 3: 交互式探针 (Interactive Probing)
> 开始定位用户的层级。

1. 基于用户背景，选择一个【中等难度】或【略高于用户自述水平】的关键概念。
2. **[测试提问]**: 生成一道侧重于"判断"或"实战避坑"的问题。 -> *等待回复*
3. **[评估与循环]**:
   - 回答正确且深刻 -> 提升难度，问更高层级。
   - 回答错误或模糊 -> 降低难度，问基础层级。
   - **终止条件**: 当以 90% 置信度确定用户处于某个具体层级时，停止提问，进入 Phase 4。

## Phase 4: 最终报告 (Final Report)
> 请严格按以下格式输出最终报告：

### 1. 学习契约概览
- **学习主题**: [用户 Phase 1 的输入]
- **核心目的**: [用户 Phase 1 的输入]
- **定位结论**: 📍 Level [X] - [该层级名称]

### 2. 学习全景路线图 (Map)
> **渲染指令**: 遍历 Phase 2 中构建的依赖树，从 Level 1 输出到 Level N。**根据实际总层数 N 动态生成列表。**
> 标记说明: ✅=已掌握 | 📍=当前位置(重点) | 🔒=未解锁(待学)

- ✅ **Level 1: [名称]**
    - *关键能力*: [简述]
- ... (此处动态展开中间层级) ...
- 📍 **Level X: [名称] (YOU ARE HERE)**
    - 🎯 **当前突破点**: [该层级最核心的一句话目标]
- ... (此处动态展开剩余层级) ...
- 🔒 **Level N: [名称]**

### 3. 诊断与建议
- **判定理由**: [基于刚才的测试，客观指出用户懂了什么，哪里卡住了]
- **Action Item**: [针对当前 Level 📍 的第一步具体行动建议]

---
**现在，请执行 Phase 1 的 [第一问]。**`;

const SYSTEM_PROMPT_ENGINE = `# Role: 深度学习执行引擎 (Deep Learning Execution Engine)

# Context (上下文)
我将为你提供一份【学习全景最终报告】
该报告包含了：
1. 我的【学习主题】与【核心目的】。
2. 整个领域的【全景地图】。
3. 我当前所处的【Level X】（锁定坐标）。

# Core Philosophy (核心指令)
你需要严格遵循以下"学-习"哲学来生成素材：
1. **理解 (Learn)**: 解释核心概念。重点在于讲清楚"是什么"、"为什么"以及"解决了什么问题"。
2. **适配 (Fit)**: **严禁为了炫技而人为拔高难度**。
    - 如果 Level X 是基础层：提供清晰、直观的基础练习，确保我构建正确的心理表征。
    - 如果 Level X 是进阶层：提供结合场景的综合练习。
    - 只有当 Level X 是专家层时：才引入极端的 Edge Cases。
    **标准是：素材难度必须精确匹配当前 Level 的定义。**
3. **克制 (Focus)**: 绝对禁止提供 Level X+1 及以上的内容。一切资源仅服务于攻克当前 Level。

# Workflow (执行流程)
请读取我提供的报告，提取 **Current Level (Level X)**，并生成以下格式的**【单次迭代教材】**：

## 1. 目标校准 (Target Alignment)
- **当前任务**: [Level X 名称]
- **学习价值**: 学会这个概念，能让我具备什么样的判断力？（侧重于"懂了之后能做什么"）

## 2. 核心信息输入 (The Input)
> *原则：清晰、准确、去废话*
- **概念解释**: 用符合我背景的语言解释概念。
- **关键逻辑**: 剖析该知识点的内在运行机制。
- **适用边界**: 告诉我在什么情况下**应该**用这个，什么情况下**不该**用（这是提升决策力的关键）。

## 3. 适配性练习 (Adaptive Practice)
> *请根据 Level X 的层级属性设计练习：*
- **场景描述**: 构造一个符合当前难度的具体场景。
- **任务指令**:
    - *Action*: [具体的操作任务，目的是验证我是否真的理解了输入的信息]
    - *Reflection*: [引导我思考该操作背后的原理]
- **验证标准**: 提供一个"自检清单"或"预期结果"，帮我判断自己是否掌握了。（不要直接给答案，要给判断依据）。

## 4. 经验总结引导 (Integration)
- 请简述：这个概念是如何从上一层级 (Level X-1) 演变而来的？
- （可选）如果我在这个环节卡住了，可能是我哪个前置知识没弄懂？

---
**请等待我发送【最终报告】，收到后立即执行上述生成逻辑。**`;

// ====== AI SERVICE CLASS ======

class AIService {
    constructor() {
        this.provider = localStorage.getItem('ai_provider') || 'groq';
        this.apiKey = localStorage.getItem('ai_api_key') || '';
        this.model = localStorage.getItem('ai_model') || '';
        this.conversationHistory = [];
        this.currentPhase = 'architect'; // 'architect' | 'engine'
        this.abortController = null;
    }

    // ---- Config ----

    getConfig() {
        return { provider: this.provider, apiKey: this.apiKey, model: this.model };
    }

    setConfig({ provider, apiKey, model }) {
        this.provider = provider;
        this.apiKey = apiKey;
        this.model = model || this.getDefaultModel(provider);
        localStorage.setItem('ai_provider', this.provider);
        localStorage.setItem('ai_api_key', this.apiKey);
        localStorage.setItem('ai_model', this.model);
    }

    getDefaultModel(provider) {
        switch (provider) {
            case 'groq': return 'llama-3.3-70b-versatile';
            case 'gemini': return 'gemini-2.0-flash';
            case 'glm': return 'glm-4-flash';
            default: return '';
        }
    }

    isConfigured() { return !!this.apiKey; }

    // ---- List available models ----

    async listModels(provider, apiKey) {
        if (provider === 'groq') return this._listGroqModels(apiKey);
        if (provider === 'gemini') return this._listGeminiModels(apiKey);
        if (provider === 'glm') return this._listGlmModels(apiKey);
        return [];
    }

    async _listGroqModels(apiKey) {
        try {
            const resp = await fetch('https://api.groq.com/openai/v1/models', {
                headers: { 'Authorization': `Bearer ${apiKey}` },
            });
            if (!resp.ok) throw new Error(await resp.text());
            const data = await resp.json();
            return (data.data || []).map(m => ({ id: m.id, name: m.id }))
                .sort((a, b) => a.name.localeCompare(b.name));
        } catch {
            // CORS or network fallback
            return [
                { id: 'llama-3.3-70b-versatile', name: 'llama-3.3-70b-versatile' },
                { id: 'llama-3.1-70b-versatile', name: 'llama-3.1-70b-versatile' },
                { id: 'llama-3.1-8b-instant', name: 'llama-3.1-8b-instant' },
                { id: 'mixtral-8x7b-32768', name: 'mixtral-8x7b-32768' },
                { id: 'gemma2-9b-it', name: 'gemma2-9b-it' },
                { id: 'llama3-70b-8192', name: 'llama3-70b-8192' },
                { id: 'llama3-8b-8192', name: 'llama3-8b-8192' },
            ];
        }
    }

    async _listGeminiModels(apiKey) {
        const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
        );
        if (!resp.ok) throw new Error(this._parseErr(await resp.text(), 'Gemini'));
        const data = await resp.json();
        return (data.models || [])
            .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
            .map(m => ({ id: m.name.replace('models/', ''), name: m.displayName || m.name.replace('models/', '') }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    async _listGlmModels(apiKey) {
        const resp = await fetch('https://open.bigmodel.cn/api/paas/v4/models', {
            headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        if (!resp.ok) throw new Error(this._parseErr(await resp.text(), 'GLM'));
        const data = await resp.json();
        return (data.data || [])
            .filter(m => m.id && !m.id.includes('embedding'))
            .map(m => ({ id: m.id, name: m.id }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    // ---- Phase management ----

    setPhase(phase) { this.currentPhase = phase; }

    getSystemPrompt() {
        return this.currentPhase === 'engine' ? SYSTEM_PROMPT_ENGINE : SYSTEM_PROMPT_ARCHITECT;
    }

    // ---- Conversation ----

    resetConversation() {
        this.conversationHistory = [];
        this.currentPhase = 'architect';
    }

    switchToEngine(reportText) {
        this.currentPhase = 'engine';
        this.conversationHistory = [{ role: 'user', content: reportText }];
    }

    // ---- State persistence ----

    exportState() {
        return { conversationHistory: [...this.conversationHistory], currentPhase: this.currentPhase };
    }

    importState(state) {
        if (state) {
            this.conversationHistory = state.conversationHistory || [];
            this.currentPhase = state.currentPhase || 'architect';
        }
    }

    // ---- Error helper (Opt 2) ----

    _parseErr(errText, providerLabel) {
        try {
            const obj = JSON.parse(errText);
            const msg = obj?.error?.message || obj?.message || errText;
            return `${providerLabel} 返回错误：${msg}`;
        } catch {
            return `${providerLabel} API 错误：${errText}`;
        }
    }

    // ---- Unified dispatch (Opt 6) ----

    async _dispatchCall(messages, onChunk) {
        const { provider, apiKey, model } = this;
        if (provider === 'groq') {
            return this._callOpenAI(
                'https://api.groq.com/openai/v1/chat/completions',
                apiKey, model || 'llama-3.3-70b-versatile', messages, onChunk, 'Groq'
            );
        }
        if (provider === 'glm') {
            return this._callOpenAI(
                'https://open.bigmodel.cn/api/paas/v4/chat/completions',
                apiKey, model || 'glm-4-flash', messages, onChunk, 'GLM'
            );
        }
        if (provider === 'gemini') {
            return this._callGemini(model || 'gemini-2.0-flash', messages, onChunk);
        }
        throw new Error(`不支持的 AI 服务商：${provider}`);
    }

    // ---- API Calls ----

    async sendMessage(userMessage, onChunk) {
        if (!this.isConfigured()) throw new Error('请先在设置中配置 API Key');

        this.conversationHistory.push({ role: 'user', content: userMessage });
        const messages = [{ role: 'system', content: this.getSystemPrompt() }, ...this.conversationHistory];
        this.abortController = new AbortController();

        try {
            const fullResponse = await this._dispatchCall(messages, onChunk);
            this.conversationHistory.push({ role: 'assistant', content: fullResponse });
            return fullResponse;
        } catch (err) {
            this.conversationHistory.pop();
            throw err;
        }
    }

    abort() { if (this.abortController) this.abortController.abort(); }

    // ---- Regenerate last AI response (Opt 8) ----
    async replayLastMessage(onChunk) {
        if (!this.isConfigured()) throw new Error('请先配置 API Key');
        this.abortController = new AbortController();
        const messages = [{ role: 'system', content: this.getSystemPrompt() }, ...this.conversationHistory];
        const fullResponse = await this._dispatchCall(messages, onChunk);
        this.conversationHistory.push({ role: 'assistant', content: fullResponse });
        return fullResponse;
    }

    async startArchitect(onChunk) {
        this.resetConversation();
        const initMessages = [
            { role: 'system', content: this.getSystemPrompt() },
            { role: 'user', content: '你好，我准备好了，请开始。' },
        ];
        this.abortController = new AbortController();
        try {
            const fullResponse = await this._dispatchCall(initMessages, onChunk);
            this.conversationHistory.push(
                { role: 'user', content: '你好，我准备好了，请开始。' },
                { role: 'assistant', content: fullResponse }
            );
            return fullResponse;
        } catch (err) { throw err; }
    }

    // ---- OpenAI-compatible (Groq + GLM) ----

    async _callOpenAI(url, apiKey, model, messages, onChunk, label) {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model, messages, stream: true }),
            signal: this.abortController.signal,
        });
        if (!resp.ok) throw new Error(this._parseErr(await resp.text(), label));
        return this._readSSEStream(resp.body, onChunk);
    }

    // ---- Gemini API ----

    async _callGemini(model, messages, onChunk) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
        const sys = messages.find(m => m.role === 'system');
        const contents = messages
            .filter(m => m.role !== 'system')
            .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
        const body = { contents, generationConfig: { temperature: 0.7 } };
        if (sys) body.systemInstruction = { parts: [{ text: sys.content }] };

        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: this.abortController.signal,
        });
        if (!resp.ok) throw new Error(this._parseErr(await resp.text(), 'Gemini'));
        return this._readGeminiSSEStream(resp.body, onChunk);
    }

    // ---- Stream Readers ----

    async _readSSEStream(body, onChunk) {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let fullText = '', buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith('data: ')) continue;
                const data = t.slice(6);
                if (data === '[DONE]') continue;
                try {
                    const delta = JSON.parse(data).choices?.[0]?.delta?.content;
                    if (delta) { fullText += delta; if (onChunk) onChunk(delta, fullText); }
                } catch { /* skip */ }
            }
        }
        return fullText;
    }

    async _readGeminiSSEStream(body, onChunk) {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let fullText = '', buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const t = line.trim();
                if (!t.startsWith('data: ')) continue;
                try {
                    const text = JSON.parse(t.slice(6)).candidates?.[0]?.content?.parts?.[0]?.text;
                    if (text) { fullText += text; if (onChunk) onChunk(text, fullText); }
                } catch { /* skip */ }
            }
        }
        return fullText;
    }
}

// Export as global singleton
window.aiService = new AIService();
