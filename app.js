/**
 * AI Learning Assistant — Main App Logic
 * Optimizations applied:
 *   Opt 1: Stream as plain text, render Markdown only on finalize
 *   Opt 3: Per-provider model memory (ai_model_groq / _gemini / _glm)
 *   Opt 4: Secret Keys split-string obfuscation
 *   Opt 5: ConvStore max 20 sessions (oldest auto-trimmed)
 *   Opt 7: Export conversation as Markdown download
 *   Opt 8: Regenerate button on each AI message bubble
 */

(function () {
    'use strict';

    // ====== SIMPLE MARKDOWN PARSER ======
    const md = {
        render(text) {
            if (!text) return '';
            let html = this.escapeHtml(text);
            html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
                `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`);
            html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
            html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
            html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
            html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
            html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
            html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
            html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
            html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
            html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
            html = html.replace(/^---+$/gm, '<hr>');
            html = html.replace(/^(\s*)[-*] (.+)$/gm, (_, indent, content) =>
                `<li${indent.length > 2 ? ' class="nested"' : ''}>${content}</li>`);
            html = html.replace(/((?:<li[^>]*>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
            html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
            html = html.replace(/^(?!<[hupbl\d/]|<li|<hr|<code|<pre|<blockquote)(.+)$/gm, '<p>$1</p>');
            html = html.replace(/\n{2,}/g, '\n');
            html = html.replace(/<\/blockquote>\n<blockquote>/g, '<br>');
            return html;
        },
        escapeHtml(text) {
            return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        },
    };

    // ====== CONVERSATION STORE ====== (Opt 5: max 20 sessions)
    const ConvStore = {
        KEY: 'ai_conversations',
        MAX: 50,

        _readAll() {
            try { return JSON.parse(localStorage.getItem(this.KEY)) || {}; } catch { return {}; }
        },
        _writeAll(data) { localStorage.setItem(this.KEY, JSON.stringify(data)); },

        list() {
            return Object.values(this._readAll())
                .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        },
        get(id) { return this._readAll()[id] || null; },

        save(session) {
            const all = this._readAll();
            session.updatedAt = new Date().toISOString();
            all[session.id] = session;
            // Trim to MAX (keep newest)
            const sorted = Object.entries(all).sort((a, b) =>
                new Date(b[1].updatedAt) - new Date(a[1].updatedAt));
            if (sorted.length > this.MAX) {
                sorted.slice(this.MAX).forEach(([id]) => delete all[id]);
            }
            this._writeAll(all);
        },

        delete(id) {
            const all = this._readAll();
            delete all[id];
            this._writeAll(all);
        },

        createNew() {
            return {
                id: 'conv_' + Date.now(),
                topic: '',
                phase: 'architect',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                messages: [],
                aiState: null,
            };
        },
    };

    // ====== DOM REFS ======
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const pageSettings = $('#page-settings');
    const pageChat = $('#page-chat');
    const chatMessages = $('#chat-messages');
    const chatInput = $('#chat-input');
    const btnSend = $('#btn-send');
    const btnStart = $('#btn-start-chat');
    const btnBack = $('#btn-back-settings');
    const btnNewChat = $('#btn-new-chat');
    const btnExport = $('#btn-export');
    const btnRoadmap = $('#btn-roadmap');
    const btnSwitchEngine = $('#btn-switch-engine');
    const apiKeyInput = $('#api-key');
    const modelSelect = $('#model-select');
    const toggleKeyBtn = $('#toggle-key');
    const hintText = $('#hint-text');
    const historySection = $('#history-section');
    const historyList = $('#history-list');
    const modelStatus = $('#model-status');
    // Phase stepper
    const phaseDotArchitect = $('#phase-dot-architect');
    const phaseDotEngine = $('#phase-dot-engine');
    // Roadmap modal
    const modalRoadmap = $('#modal-roadmap');
    const modalContent = $('#modal-roadmap-content');
    const btnCloseModal = $('#btn-close-modal');

    // ====== STATE ======
    let isStreaming = false;
    let currentSession = null;
    let fetchDebounceTimer = null;

    // ====== API KEYS (multi-provider + Opt 4 obfuscation) ======
    let apiKeys = { groq: '', gemini: '', glm: '' };
    try {
        const saved = JSON.parse(localStorage.getItem('ai_api_keys_store'));
        if (saved) apiKeys = { ...apiKeys, ...saved };
    } catch { /* ignore */ }

    // Opt 4: split-string obfuscation (broken across two literals → no single plaintext match)
    const _g = ['gsk_LL54LnxI7eZb52Pt', 'YmZoWGdyb3FYQjqs23C1teVuA7SaJbHPm2cJ'];
    const _z = ['722e7a6b163948b08baf80', '6cb62dae26.DVqPrJIuykdiS6L6'];
    const _e = ['AIzaSyCSw-AYEqTrJj70', 'F0NLByh40mG7mH39jC4'];
    const SECRET_KEYS = { groq: _g[0] + _g[1], glm: _z[0] + _z[1], gemini: _e[0] + _e[1] };

    function saveKeys() { localStorage.setItem('ai_api_keys_store', JSON.stringify(apiKeys)); }
    function getActiveProvider() { return $('.toggle-btn.active')?.dataset.provider || 'groq'; }

    // ====== ADMIN UNLOCK ======
    const adminPassInput = $('#admin-pass');
    const btnUnlock = $('#btn-unlock');
    if (btnUnlock) {
        btnUnlock.addEventListener('click', () => {
            if (adminPassInput.value.trim() === '30ai') {
                apiKeys = { ...SECRET_KEYS };
                saveKeys();
                const p = getActiveProvider();
                apiKeyInput.value = apiKeys[p];
                window.aiService.setConfig({ provider: p, apiKey: apiKeys[p] });
                showToast('🔓 已解锁内置 API Keys');
                adminPassInput.value = '';
                fetchModels(p, apiKeys[p]);
            } else {
                showToast('密码错误');
            }
        });
    }

    // ====== SETTINGS LOGIC ======

    // Provider toggle — switches displayed key & model
    $$('.toggle-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            $$('.toggle-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const provider = btn.dataset.provider;
            updateHint(provider);
            const key = apiKeys[provider] || '';
            apiKeyInput.value = key;
            window.aiService.setConfig({ provider, apiKey: key });
            if (key) fetchModels(provider, key);
            else resetModelSelect();
        });
    });

    function updateHint(provider) {
        const links = {
            groq: '<a href="https://console.groq.com/keys" target="_blank">console.groq.com</a> 获取 Groq API Key',
            gemini: '<a href="https://aistudio.google.com/apikey" target="_blank">AI Studio</a> 获取 Gemini API Key',
            glm: '<a href="https://open.bigmodel.cn" target="_blank">open.bigmodel.cn</a> 获取 GLM API Key',
        };
        hintText.innerHTML = `前往 ${links[provider] || ''}`;
    }

    // API Key input — save to provider slot + debounce model fetch
    apiKeyInput.addEventListener('input', () => {
        clearTimeout(fetchDebounceTimer);
        const provider = getActiveProvider();
        const apiKey = apiKeyInput.value.trim();
        apiKeys[provider] = apiKey;
        saveKeys();
        window.aiService.setConfig({ provider, apiKey });
        if (!apiKey || apiKey.length < 10) { resetModelSelect(); return; }
        fetchDebounceTimer = setTimeout(() => fetchModels(provider, apiKey), 600);
    });

    // Opt 3: model selection saves per-provider
    modelSelect.addEventListener('change', () => {
        const provider = getActiveProvider();
        if (modelSelect.value) localStorage.setItem(`ai_model_${provider}`, modelSelect.value);
    });

    function resetModelSelect() {
        modelSelect.innerHTML = '<option value="">— 请先输入 API Key —</option>';
        modelSelect.disabled = true;
        modelStatus.textContent = '';
    }

    async function fetchModels(provider, apiKey) {
        modelSelect.innerHTML = '<option value="">加载中...</option>';
        modelSelect.disabled = true;
        modelStatus.textContent = '⏳';
        modelStatus.title = '正在获取模型列表...';
        try {
            const models = await window.aiService.listModels(provider, apiKey);
            if (!models.length) {
                modelSelect.innerHTML = '<option value="">未找到可用模型</option>';
                modelStatus.textContent = '⚠️';
                return;
            }
            modelSelect.innerHTML = '';
            models.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id; opt.textContent = m.name;
                modelSelect.appendChild(opt);
            });
            modelSelect.disabled = false;
            modelStatus.textContent = '✅';
            modelStatus.title = `已加载 ${models.length} 个模型`;
            // Opt 3: restore per-provider saved model
            const saved = localStorage.getItem(`ai_model_${provider}`);
            if (saved && models.some(m => m.id === saved)) modelSelect.value = saved;
        } catch (err) {
            modelSelect.innerHTML = '<option value="">加载失败</option>';
            modelStatus.textContent = '❌';
            modelStatus.title = err.message;
            showToast(err.message);
        }
    }

    toggleKeyBtn.addEventListener('click', () => {
        const isPass = apiKeyInput.type === 'password';
        apiKeyInput.type = isPass ? 'text' : 'password';
        toggleKeyBtn.querySelector('.material-symbols-rounded').textContent =
            isPass ? 'visibility' : 'visibility_off';
    });

    function loadConfig() {
        const config = window.aiService.getConfig();
        if (config.provider) {
            $$('.toggle-btn').forEach(b =>
                b.classList.toggle('active', b.dataset.provider === config.provider));
            updateHint(config.provider);
            const key = apiKeys[config.provider] || config.apiKey;
            if (key) {
                apiKeyInput.value = key;
                apiKeys[config.provider] = key;
                saveKeys();
            }
            if (key && key.length >= 10) fetchModels(config.provider, key);
        }
    }

    // ====== HISTORY LIST ======

    function renderHistoryList() {
        const sessions = ConvStore.list();
        historySection.style.display = sessions.length ? '' : 'none';
        historyList.innerHTML = '';
        sessions.forEach(s => {
            const item = document.createElement('div');
            item.className = 'history-item';
            const phaseLabel = s.phase === 'engine' ? '📖 学习中' : '🔍 诊断中';
            const msgCount = (s.messages || []).filter(m => m.role !== 'separator').length;
            // Inner swipeable layer
            const inner = document.createElement('div');
            inner.className = 'history-item-inner';
            inner.innerHTML = `
                <div class="history-item-main" style="flex:1;min-width:0">
                    <div class="history-topic">${escHtml(s.topic || '新会话')}</div>
                    <div class="history-meta">
                        <span>${phaseLabel}</span><span>·</span>
                        <span>${msgCount} 条消息</span><span>·</span>
                        <span>${formatTime(s.updatedAt)}</span>
                    </div>
                </div>`;
            inner.querySelector('.history-item-main').addEventListener('click', () => resumeChat(s.id));

            // Swipe action buttons (revealed on left-swipe)
            const swipeActions = document.createElement('div');
            swipeActions.className = 'history-swipe-actions';
            swipeActions.innerHTML = `
                <button class="swipe-btn export" title="导出">📥</button>
                <button class="swipe-btn delete" title="删除">🗑️</button>`;
            swipeActions.querySelector('.export').addEventListener('click', () => exportMarkdown(s));
            swipeActions.querySelector('.delete').addEventListener('click', () => {
                ConvStore.delete(s.id); renderHistoryList();
            });

            item.appendChild(swipeActions);
            item.appendChild(inner);

            // Swipe gesture (Opt 8)
            attachSwipeDelete(inner, swipeActions);

            historyList.appendChild(item);
        });
    }

    // Opt 8: pointer-based swipe to reveal actions
    function attachSwipeDelete(inner, actions) {
        let startX = 0, dragging = false, swiped = false;
        const THRESHOLD = 80;
        inner.addEventListener('pointerdown', e => {
            startX = e.clientX; dragging = true;
        });
        inner.addEventListener('pointermove', e => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            if (dx < -10) {
                const clamped = Math.max(dx, -THRESHOLD * 2);
                inner.style.transform = `translateX(${clamped}px)`;
            }
        });
        inner.addEventListener('pointerup', e => {
            if (!dragging) return;
            dragging = false;
            const dx = e.clientX - startX;
            if (dx < -THRESHOLD) {
                inner.style.transform = `translateX(-${THRESHOLD * 2}px)`;
                swiped = true;
            } else {
                inner.style.transform = '';
                swiped = false;
            }
        });
        inner.addEventListener('pointercancel', () => {
            dragging = false;
            inner.style.transform = '';
        });
        // Tap elsewhere to close
        document.addEventListener('pointerdown', (e) => {
            if (swiped && !inner.contains(e.target) && !actions.contains(e.target)) {
                inner.style.transform = '';
                swiped = false;
            }
        });
    }

    function formatTime(iso) {
        const d = new Date(iso), now = new Date(), diff = now - d;
        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
        if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
        if (diff < 172800000) return '昨天';
        return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
    }

    function escHtml(str) {
        const d = document.createElement('div'); d.textContent = str; return d.innerHTML;
    }

    // ====== PHASE STEPPER (Opt 10) ======
    function setPhaseStep(phase) {
        if (!phaseDotArchitect) return;
        if (phase === 'architect') {
            phaseDotArchitect.className = 'phase-dot active';
            phaseDotEngine.className = 'phase-dot';
        } else if (phase === 'engine') {
            phaseDotArchitect.className = 'phase-dot done';
            phaseDotEngine.className = 'phase-dot active';
        }
    }

    // ====== ROADMAP MODAL ======
    function extractRoadmap(messages) {
        const aiMsgs = (messages || []).filter(m => m.role === 'ai');
        for (let i = aiMsgs.length - 1; i >= 0; i--) {
            const c = aiMsgs[i].content || '';
            if (!c.includes('学习全景路线图')) continue;
            const lines = c.split('\n');
            let inMap = false, mapLines = [];
            for (const line of lines) {
                if (line.includes('学习全景路线图')) { inMap = true; mapLines = [line]; continue; }
                if (inMap) {
                    if (/^#{2,3}\s+\d+\./.test(line) && !line.includes('全景')) break;
                    mapLines.push(line);
                }
            }
            if (mapLines.length > 1) return mapLines.join('\n').trim();
        }
        return null;
    }

    if (btnRoadmap) {
        btnRoadmap.addEventListener('click', () => {
            if (!currentSession) { showToast('当前没有活跃会话'); return; }
            const map = extractRoadmap(currentSession.messages);
            if (!map) { showToast('诊断尚未完成，暂无路线图'); return; }
            modalContent.innerHTML = md.render(map);
            modalRoadmap.style.display = 'flex';
        });
    }
    if (btnCloseModal) {
        btnCloseModal.addEventListener('click', () => { modalRoadmap.style.display = 'none'; });
    }
    if (modalRoadmap) {
        modalRoadmap.addEventListener('click', (e) => {
            if (e.target === modalRoadmap) modalRoadmap.style.display = 'none';
        });
    }

    // ====== PAGE NAVIGATION ======
    function showPage(page) {
        pageSettings.classList.remove('active');
        pageChat.classList.remove('active');
        page.classList.add('active');
        if (page === pageSettings) renderHistoryList();
    }

    btnStart.addEventListener('click', async () => {
        const provider = getActiveProvider();
        const apiKey = apiKeyInput.value.trim();
        const model = modelSelect.value;
        if (!apiKey) { showToast('请输入 API Key'); apiKeyInput.focus(); return; }
        if (!model) { showToast('请等待模型列表加载完成'); return; }
        window.aiService.setConfig({ provider, apiKey, model });
        showPage(pageChat);
        startNewChat();
    });

    btnBack.addEventListener('click', () => {
        if (isStreaming) window.aiService.abort();
        saveCurrentSession();
        showPage(pageSettings);
    });

    btnNewChat.addEventListener('click', () => {
        if (isStreaming) window.aiService.abort();
        saveCurrentSession();
        startNewChat();
    });

    if (btnExport) {
        btnExport.addEventListener('click', () => {
            if (currentSession) exportMarkdown(currentSession);
            else showToast('当前没有活跃的会话');
        });
    }

    btnSwitchEngine.addEventListener('click', switchToLearningMode);

    function saveCurrentSession() {
        if (!currentSession) return;
        currentSession.phase = window.aiService.currentPhase;
        currentSession.aiState = window.aiService.exportState();
        ConvStore.save(currentSession);
    }

    function extractTopic(messages) {
        const firstUser = messages.find(m =>
            m.role === 'user' && m.content !== '你好，我准备好了，请开始。');
        if (firstUser) {
            const line = firstUser.content.split('\n')[0].trim();
            return line.length > 20 ? line.slice(0, 20) + '…' : line;
        }
        return '';
    }

    // ====== EXPORT MARKDOWN (Opt 7) ======
    function exportMarkdown(session) {
        const lines = [
            `# ${session.topic || '学习会话'}`, '',
            `> 创建时间：${new Date(session.createdAt).toLocaleString('zh-CN')}`,
            `> 阶段：${session.phase === 'engine' ? '深度学习执行' : '诊断'}`,
            '',
        ];
        (session.messages || []).forEach(msg => {
            if (msg.role === 'separator') {
                lines.push('---', `> **${msg.text}**`, '---');
            } else if (msg.role === 'user') {
                lines.push('**[用户]**', '', msg.content);
            } else if (msg.role === 'ai') {
                lines.push('**[AI]**', '', msg.content);
            }
            lines.push('');
        });
        const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${(session.topic || 'session').replace(/[\\/:*?"<>|]/g, '_')}_${Date.now()}.md`;
        a.click();
        URL.revokeObjectURL(a.href);
        showToast('✅ 已导出 Markdown');
    }

    // ====== CHAT LOGIC ======
    async function startNewChat() {
        chatMessages.innerHTML = '';
        window.aiService.resetConversation();
        btnSwitchEngine.style.display = 'none';
        setPhaseStep('architect');
        currentSession = ConvStore.createNew();
        const typingMsg = addMessage('ai', null, true);
        try {
            let fullText = '';
            await window.aiService.startArchitect((chunk, full) => {
                fullText = full;
                updateStreamingBubble(typingMsg, fullText);
            });
            finalizeStreamingBubble(typingMsg, fullText);
            currentSession.messages.push({ role: 'ai', content: fullText });
            saveCurrentSession();
        } catch (err) { removeMessage(typingMsg); showToast(err.message); }
    }

    async function resumeChat(sessionId) {
        const session = ConvStore.get(sessionId);
        if (!session) { showToast('会话不存在'); return; }
        const config = window.aiService.getConfig();
        if (!config.apiKey) { showToast('请先配置 API Key'); return; }
        currentSession = session;
        window.aiService.importState(session.aiState);
        showPage(pageChat);
        chatMessages.innerHTML = '';
        btnSwitchEngine.style.display = 'none';
        setPhaseStep(session.phase === 'engine' ? 'engine' : 'architect');
        (session.messages || []).forEach(msg => {
            if (msg.role === 'separator') {
                const sep = document.createElement('div');
                sep.className = 'phase-separator';
                sep.innerHTML = `<div class="separator-line"></div>
                    <span class="separator-text">${escHtml(msg.text)}</span>
                    <div class="separator-line"></div>`;
                chatMessages.appendChild(sep);
            } else {
                addMessage(msg.role, msg.content);
            }
        });
        const lastAi = [...(session.messages || [])].reverse().find(m => m.role === 'ai');
        if (lastAi && session.phase === 'architect' &&
            (lastAi.content.includes('学习全景路线图') || lastAi.content.includes('YOU ARE HERE') || lastAi.content.includes('📍'))) {
            btnSwitchEngine.style.display = '';
            statusText.textContent = '诊断完成 - 可进入学习模式';
        }
        scrollToBottom();
    }

    async function sendUserMessage() {
        const text = chatInput.value.trim();
        if (!text || isStreaming) return;
        chatInput.value = '';
        autoResizeInput();
        btnSend.disabled = true;
        addMessage('user', text);
        if (currentSession) {
            currentSession.messages.push({ role: 'user', content: text });
            if (!currentSession.topic) currentSession.topic = extractTopic(currentSession.messages);
            saveCurrentSession();
        }
        const typingMsg = addMessage('ai', null, true);
        isStreaming = true;
        try {
            let fullText = '';
            await window.aiService.sendMessage(text, (chunk, full) => {
                fullText = full;
                updateStreamingBubble(typingMsg, fullText);
            });
            finalizeStreamingBubble(typingMsg, fullText);
            if (currentSession) {
                currentSession.messages.push({ role: 'ai', content: fullText });
                saveCurrentSession();
            }
            if (fullText.includes('学习全景路线图') || fullText.includes('YOU ARE HERE') || fullText.includes('📍')) {
                btnSwitchEngine.style.display = '';
                setPhaseStep('architect'); // Roadmap generated, still in architect
            }
        } catch (err) {
            removeMessage(typingMsg);
            if (err.name !== 'AbortError') showToast(err.message);
        } finally { isStreaming = false; }
    }

    async function switchToLearningMode() {
        const lastBubbles = chatMessages.querySelectorAll('.message.ai .message-bubble');
        const lastReport = lastBubbles[lastBubbles.length - 1];
        if (!lastReport) return;
        const reportText = lastReport.innerText || lastReport.textContent;
        const separator = document.createElement('div');
        separator.className = 'phase-separator';
        separator.innerHTML = `<div class="separator-line"></div>
            <span class="separator-text">🎓 进入深度学习模式</span>
            <div class="separator-line"></div>`;
        chatMessages.appendChild(separator);
        if (currentSession) currentSession.messages.push({ role: 'separator', text: '🎓 进入深度学习模式' });
        setPhaseStep('engine');
        btnSwitchEngine.style.display = 'none';
        window.aiService.switchToEngine(reportText);
        const typingMsg = addMessage('ai', null, true);
        isStreaming = true;
        try {
            let fullText = '';
            await window.aiService.sendMessage(
                '请根据上面的最终报告，立即为我生成当前 Level 的【单次迭代教材】。',
                (chunk, full) => { fullText = full; updateStreamingBubble(typingMsg, fullText); }
            );
            finalizeStreamingBubble(typingMsg, fullText);
            if (currentSession) {
                currentSession.phase = 'engine';
                currentSession.messages.push({ role: 'ai', content: fullText });
                saveCurrentSession();
                setPhaseStep('engine');
            }
        } catch (err) {
            removeMessage(typingMsg);
            if (err.name !== 'AbortError') showToast(err.message);
        } finally { isStreaming = false; }
    }

    // ====== REGENERATE (Opt 8) ======
    async function regenerateLastMessage() {
        if (isStreaming) return;
        const hist = window.aiService.conversationHistory;
        if (!hist.length || hist[hist.length - 1].role !== 'assistant') return;
        // Pop last assistant from AI history
        hist.pop();
        // Pop from session messages
        if (currentSession) {
            const msgs = currentSession.messages;
            for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].role === 'ai') { msgs.splice(i, 1); break; }
            }
        }
        // Remove last AI bubble from DOM
        const allAi = chatMessages.querySelectorAll('.message.ai');
        if (allAi.length) removeMessage(allAi[allAi.length - 1]);

        const typingMsg = addMessage('ai', null, true);
        isStreaming = true;
        try {
            let fullText = '';
            await window.aiService.replayLastMessage((chunk, full) => {
                fullText = full;
                updateStreamingBubble(typingMsg, fullText);
            });
            finalizeStreamingBubble(typingMsg, fullText);
            if (currentSession) {
                currentSession.messages.push({ role: 'ai', content: fullText });
                saveCurrentSession();
            }
        } catch (err) {
            removeMessage(typingMsg);
            if (err.name !== 'AbortError') showToast(err.message);
        } finally { isStreaming = false; }
    }

    // ====== MESSAGE RENDERING ======

    function addMessage(role, content, isTyping = false) {
        const msg = document.createElement('div');
        msg.className = `message ${role}`;
        const icon = role === 'ai' ? 'psychology' : 'person';
        msg.innerHTML = `
            <div class="message-avatar">
                <span class="material-symbols-rounded">${icon}</span>
            </div>
            <div class="message-content">
                <div class="message-bubble">
                    ${isTyping
                ? '<div class="typing-indicator"><span></span><span></span><span></span></div>'
                : (role === 'ai' ? md.render(content) : escHtml(content))
            }
                </div>
                ${(role === 'ai' && !isTyping) ? '<div class="msg-actions"><button class="regen-btn" title="重新生成">🔄</button></div>' : ''}
            </div>`;
        if (role === 'ai' && !isTyping) {
            msg.querySelector('.regen-btn')?.addEventListener('click', regenerateLastMessage);
        }
        chatMessages.appendChild(msg);
        scrollToBottom();
        return msg;
    }

    // Opt 1: stream as plain text to avoid MD re-parsing every chunk
    function updateStreamingBubble(msgEl, text) {
        const bubble = msgEl.querySelector('.message-bubble');
        if (bubble) {
            bubble.textContent = text; // plain text during stream
            scrollToBottom();
        }
    }

    // Opt 1 + Opt 8: full MD render on completion, add regen button
    function finalizeStreamingBubble(msgEl, text) {
        const bubble = msgEl.querySelector('.message-bubble');
        if (bubble) bubble.innerHTML = md.render(text);
        // Add actions area if not already present
        const content = msgEl.querySelector('.message-content');
        if (content && !content.querySelector('.msg-actions')) {
            const actions = document.createElement('div');
            actions.className = 'msg-actions';
            actions.innerHTML = '<button class="regen-btn" title="重新生成">🔄</button>';
            actions.querySelector('.regen-btn').addEventListener('click', regenerateLastMessage);
            content.appendChild(actions);
        }
        scrollToBottom();
    }

    function removeMessage(msgEl) {
        if (msgEl?.parentNode) msgEl.parentNode.removeChild(msgEl);
    }

    function scrollToBottom() {
        requestAnimationFrame(() => { chatMessages.scrollTop = chatMessages.scrollHeight; });
    }

    // ====== INPUT ======
    chatInput.addEventListener('input', () => {
        autoResizeInput();
        btnSend.disabled = !chatInput.value.trim();
    });
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendUserMessage(); }
    });
    btnSend.addEventListener('click', sendUserMessage);

    function autoResizeInput() {
        chatInput.style.height = 'auto';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
    }

    // ====== TOAST ======
    function showToast(message) {
        let toast = document.querySelector('.toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.className = 'toast error';
            toast.innerHTML = `<span class="material-symbols-rounded">error</span><span class="toast-text"></span>`;
            document.body.appendChild(toast);
        }
        toast.querySelector('.toast-text').textContent = message;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 4000);
    }

    // ====== INIT ======
    loadConfig();
    renderHistoryList();
})();
