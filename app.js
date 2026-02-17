/**
 * AI Learning Assistant — Main App Logic
 * Chat management, Markdown rendering, settings, streaming display, conversation persistence
 */

(function () {
    'use strict';

    // ====== SIMPLE MARKDOWN PARSER ======
    const md = {
        render(text) {
            if (!text) return '';
            let html = this.escapeHtml(text);

            // Code blocks (```...```)
            html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
                return `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`;
            });

            // Inline code
            html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

            // Headers (process from h4 to h1)
            html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
            html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
            html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
            html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

            // Bold and Italic
            html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
            html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
            html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

            // Blockquotes
            html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

            // Horizontal rule
            html = html.replace(/^---+$/gm, '<hr>');

            // Unordered lists
            html = html.replace(/^(\s*)[-*] (.+)$/gm, (_, indent, content) => {
                const level = indent.length > 2 ? ' class="nested"' : '';
                return `<li${level}>${content}</li>`;
            });
            html = html.replace(/((?:<li[^>]*>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

            // Ordered lists
            html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

            // Paragraphs - wrap remaining lines
            html = html.replace(/^(?!<[hupbl\d/]|<li|<hr|<code|<pre|<blockquote)(.+)$/gm, '<p>$1</p>');

            // Clean up extra whitespace
            html = html.replace(/\n{2,}/g, '\n');

            // Merge adjacent blockquotes
            html = html.replace(/<\/blockquote>\n<blockquote>/g, '<br>');

            return html;
        },

        escapeHtml(text) {
            return text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        },
    };

    // ====== CONVERSATION STORE ======
    const ConvStore = {
        KEY: 'ai_conversations',

        _readAll() {
            try {
                return JSON.parse(localStorage.getItem(this.KEY)) || {};
            } catch { return {}; }
        },

        _writeAll(data) {
            localStorage.setItem(this.KEY, JSON.stringify(data));
        },

        list() {
            const all = this._readAll();
            return Object.values(all)
                .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        },

        get(id) {
            return this._readAll()[id] || null;
        },

        save(session) {
            const all = this._readAll();
            session.updatedAt = new Date().toISOString();
            all[session.id] = session;
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
                messages: [],   // { role, content } for UI display
                aiState: null,  // from aiService.exportState()
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
    const btnSwitchEngine = $('#btn-switch-engine');
    const apiKeyInput = $('#api-key');
    const modelSelect = $('#model-select');
    const statusText = $('#status-text');
    const toggleKeyBtn = $('#toggle-key');
    const hintText = $('#hint-text');
    const historySection = $('#history-section');
    const historyList = $('#history-list');

    // ====== STATE ======
    let isStreaming = false;
    let currentSession = null; // active ConversationSession
    let fetchDebounceTimer = null;
    const modelStatus = $('#model-status');

    // API Keys Management
    // Default empty keys
    let apiKeys = {
        groq: '',
        gemini: '',
        glm: ''
    };
    // Load from storage if exists
    try {
        const savedKeys = JSON.parse(localStorage.getItem('ai_api_keys_store'));
        if (savedKeys) apiKeys = { ...apiKeys, ...savedKeys };
    } catch (e) { }

    // Secret Keys (Obfuscated slightly but visible in source if inspected)
    const SECRET_KEYS = {
        groq: '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',
        glm: '722e7a6b163948b08baf806cb62dae26.DVqPrJIuykdiS6L6',
        gemini: 'AIzaSyAKEyUDE5tPgWbOw2F5yPO4WBARBp9Qht0'
    };

    // Admin Unlock
    const adminPassInput = $('#admin-pass');
    const btnUnlock = $('#btn-unlock');

    if (btnUnlock) {
        btnUnlock.addEventListener('click', () => {
            const code = adminPassInput.value.trim();
            if (code === '30ai') {
                // Inject keys
                apiKeys = { ...SECRET_KEYS };
                saveKeys();

                // Update UI based on current provider
                const currentProvider = $('.toggle-btn.active').dataset.provider;
                apiKeyInput.value = apiKeys[currentProvider];
                window.aiService.setConfig({
                    provider: currentProvider,
                    apiKey: apiKeys[currentProvider]
                });

                showToast('🔓 已解锁内置 API Keys');
                adminPassInput.value = '';

                // Auto fetch
                fetchModels(currentProvider, apiKeys[currentProvider]);
            } else {
                showToast('密码错误');
            }
        });
    }

    function saveKeys() {
        localStorage.setItem('ai_api_keys_store', JSON.stringify(apiKeys));
    }

    // ====== SETTINGS LOGIC ======

    // Provider toggle
    $$('.toggle-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            $$('.toggle-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            const provider = btn.dataset.provider;
            updateHint(provider);

            // Switch key input to saved key for this provider
            const key = apiKeys[provider] || '';
            apiKeyInput.value = key;

            // Update service config immediately
            window.aiService.setConfig({
                provider: provider,
                apiKey: key
            });

            if (key) {
                fetchModels(provider, key);
            } else {
                resetModelSelect();
            }
        });
    });

    function updateHint(provider) {
        if (provider === 'groq') {
            hintText.innerHTML = '前往 <a href="https://console.groq.com/keys" target="_blank">console.groq.com</a> 获取 Groq API Key';
        } else if (provider === 'gemini') {
            hintText.innerHTML = '前往 <a href="https://aistudio.google.com/apikey" target="_blank">AI Studio</a> 获取 Gemini API Key';
        } else if (provider === 'glm') {
            hintText.innerHTML = '前往 <a href="https://open.bigmodel.cn" target="_blank">open.bigmodel.cn</a> 获取 GLM API Key';
        }
    }


    // API Key input — debounced model fetching
    apiKeyInput.addEventListener('input', () => {
        clearTimeout(fetchDebounceTimer);
        const apiKey = apiKeyInput.value.trim();

        // Save to current provider slot
        const provider = $('.toggle-btn.active').dataset.provider;
        apiKeys[provider] = apiKey;
        saveKeys();

        // Update service
        window.aiService.setConfig({
            provider: provider,
            apiKey: apiKey
        });

        if (!apiKey || apiKey.length < 10) {
            resetModelSelect();
            return;
        }
        fetchDebounceTimer = setTimeout(() => {
            fetchModels(provider, apiKey);
        }, 600);
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
            if (models.length === 0) {
                modelSelect.innerHTML = '<option value="">未找到可用模型</option>';
                modelStatus.textContent = '⚠️';
                modelStatus.title = '未找到可用模型';
                return;
            }

            modelSelect.innerHTML = '';
            models.forEach((m) => {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = m.name;
                modelSelect.appendChild(opt);
            });
            modelSelect.disabled = false;
            modelStatus.textContent = '✅';
            modelStatus.title = `已加载 ${models.length} 个模型`;

            const saved = localStorage.getItem('ai_model');
            if (saved && models.some(m => m.id === saved)) {
                modelSelect.value = saved;
            } else if (models.length > 0) {
                // Auto select first
                modelSelect.value = models[0].id;
                window.aiService.setConfig({ ...window.aiService.getConfig(), model: models[0].id });
            }
        } catch (err) {
            modelSelect.innerHTML = '<option value="">加载失败</option>';
            modelStatus.textContent = '❌';
            modelStatus.title = err.message;
            showToast(err.message);
        }
    }

    // Toggle password visibility
    toggleKeyBtn.addEventListener('click', () => {
        const isPassword = apiKeyInput.type === 'password';
        apiKeyInput.type = isPassword ? 'text' : 'password';
        toggleKeyBtn.querySelector('.material-symbols-rounded').textContent =
            isPassword ? 'visibility' : 'visibility_off';
    });

    // Load saved config
    function loadConfig() {
        const config = window.aiService.getConfig();
        // Provider
        if (config.provider) {
            $$('.toggle-btn').forEach((b) => {
                b.classList.toggle('active', b.dataset.provider === config.provider);
            });
            updateHint(config.provider);

            // Load key from our new storage if available, fallback to config.apiKey (legacy)
            const key = apiKeys[config.provider] || config.apiKey;
            if (key) {
                apiKeyInput.value = key;
                apiKeys[config.provider] = key; // Ensure synced
                saveKeys();
            }

            // If we have a saved key, auto-fetch models
            if (key && key.length >= 10) {
                fetchModels(config.provider, key);
            }
        }
    }

    // ====== HISTORY LIST ======

    function renderHistoryList() {
        const sessions = ConvStore.list();
        if (sessions.length === 0) {
            historySection.style.display = 'none';
            return;
        }
        historySection.style.display = '';
        historyList.innerHTML = '';

        sessions.forEach((s) => {
            const item = document.createElement('div');
            item.className = 'history-item';
            const phaseLabel = s.phase === 'engine' ? '📖 学习中' : '🔍 诊断中';
            const timeStr = formatTime(s.updatedAt);
            const msgCount = (s.messages || []).filter(m => m.role !== 'separator').length;

            item.innerHTML = `
                <div class="history-item-main">
                    <div class="history-topic">${escHtml(s.topic || '新会话')}</div>
                    <div class="history-meta">
                        <span>${phaseLabel}</span>
                        <span>·</span>
                        <span>${msgCount} 条消息</span>
                        <span>·</span>
                        <span>${timeStr}</span>
                    </div>
                </div>
                <button class="history-delete" title="删除">
                    <span class="material-symbols-rounded">delete</span>
                </button>
            `;

            // Resume on click
            item.querySelector('.history-item-main').addEventListener('click', () => {
                resumeChat(s.id);
            });

            // Delete
            item.querySelector('.history-delete').addEventListener('click', (e) => {
                e.stopPropagation();
                ConvStore.delete(s.id);
                renderHistoryList();
            });

            historyList.appendChild(item);
        });
    }

    function formatTime(iso) {
        const d = new Date(iso);
        const now = new Date();
        const diff = now - d;
        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
        if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
        if (diff < 172800000) return '昨天';
        return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
    }

    function escHtml(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    // ====== PAGE NAVIGATION ======

    function showPage(page) {
        pageSettings.classList.remove('active');
        pageChat.classList.remove('active');
        page.classList.add('active');
        if (page === pageSettings) {
            renderHistoryList();
        }
    }

    // Start new chat
    btnStart.addEventListener('click', async () => {
        const provider = $('.toggle-btn.active').dataset.provider;
        const apiKey = apiKeyInput.value.trim();
        const model = modelSelect.value;

        if (!apiKey) {
            showToast('请输入 API Key');
            apiKeyInput.focus();
            return;
        }

        if (!model) {
            showToast('请等待模型列表加载完成');
            return;
        }

        window.aiService.setConfig({ provider, apiKey, model });
        showPage(pageChat);
        startNewChat();
    });

    // Back to settings
    btnBack.addEventListener('click', () => {
        if (isStreaming) window.aiService.abort();
        saveCurrentSession();
        showPage(pageSettings);
    });

    // New chat
    btnNewChat.addEventListener('click', () => {
        if (isStreaming) window.aiService.abort();
        saveCurrentSession();
        startNewChat();
    });

    // Switch to engine
    btnSwitchEngine.addEventListener('click', () => {
        switchToLearningMode();
    });

    // ====== PERSISTENCE HELPERS ======

    function saveCurrentSession() {
        if (!currentSession) return;
        currentSession.phase = window.aiService.currentPhase;
        currentSession.aiState = window.aiService.exportState();
        ConvStore.save(currentSession);
    }

    function extractTopic(messages) {
        // Find first user message that isn't the init greeting
        const firstUser = messages.find(
            m => m.role === 'user' && m.content !== '你好，我准备好了，请开始。'
        );
        if (firstUser) {
            // Take first line, max 20 chars
            const line = firstUser.content.split('\n')[0].trim();
            return line.length > 20 ? line.slice(0, 20) + '…' : line;
        }
        return '';
    }

    // ====== CHAT LOGIC ======

    async function startNewChat() {
        chatMessages.innerHTML = '';
        window.aiService.resetConversation();
        btnSwitchEngine.style.display = 'none';
        statusText.textContent = '诊断阶段';

        // Create new session
        currentSession = ConvStore.createNew();

        // Show typing indicator
        const typingMsg = addMessage('ai', null, true);

        try {
            let fullText = '';
            await window.aiService.startArchitect((chunk, full) => {
                fullText = full;
                updateStreamingBubble(typingMsg, fullText);
            });

            // Final render
            finalizeStreamingBubble(typingMsg, fullText);

            // Save AI's first message
            currentSession.messages.push({ role: 'ai', content: fullText });
            saveCurrentSession();
        } catch (err) {
            removeMessage(typingMsg);
            showToast(err.message);
        }
    }

    async function resumeChat(sessionId) {
        const session = ConvStore.get(sessionId);
        if (!session) {
            showToast('会话不存在');
            return;
        }

        // Ensure API is configured
        const config = window.aiService.getConfig();
        if (!config.apiKey) {
            showToast('请先配置 API Key');
            return;
        }

        currentSession = session;

        // Restore AI service state
        window.aiService.importState(session.aiState);

        // Update UI
        showPage(pageChat);
        chatMessages.innerHTML = '';
        btnSwitchEngine.style.display = 'none';

        // Set phase indicator
        if (session.phase === 'engine') {
            statusText.textContent = '学习执行阶段';
        } else {
            statusText.textContent = '诊断阶段';
        }

        // Render all saved messages
        (session.messages || []).forEach((msg) => {
            if (msg.role === 'separator') {
                const separator = document.createElement('div');
                separator.className = 'phase-separator';
                separator.innerHTML = `
                    <div class="separator-line"></div>
                    <span class="separator-text">${escHtml(msg.text)}</span>
                    <div class="separator-line"></div>
                `;
                chatMessages.appendChild(separator);
            } else {
                addMessage(msg.role, msg.content);
            }
        });

        // Check if we should show switch button
        const lastAiMsg = [...(session.messages || [])].reverse().find(m => m.role === 'ai');
        if (lastAiMsg && session.phase === 'architect') {
            const t = lastAiMsg.content;
            if (t.includes('学习全景路线图') || t.includes('YOU ARE HERE') || t.includes('📍')) {
                btnSwitchEngine.style.display = '';
                statusText.textContent = '诊断完成 - 可进入学习模式';
            }
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

        // Save user message
        if (currentSession) {
            currentSession.messages.push({ role: 'user', content: text });
            // Extract topic from first real user answer
            if (!currentSession.topic) {
                currentSession.topic = extractTopic(currentSession.messages);
            }
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

            // Save AI message
            if (currentSession) {
                currentSession.messages.push({ role: 'ai', content: fullText });
                saveCurrentSession();
            }

            // Detect if this is the final report
            if (fullText.includes('学习全景路线图') || fullText.includes('YOU ARE HERE') || fullText.includes('📍')) {
                btnSwitchEngine.style.display = '';
                statusText.textContent = '诊断完成 - 可进入学习模式';
            }
        } catch (err) {
            removeMessage(typingMsg);
            if (err.name !== 'AbortError') {
                showToast(err.message);
            }
        } finally {
            isStreaming = false;
        }
    }

    async function switchToLearningMode() {
        // Get last AI message (the report) and switch to engine mode
        const lastAiMessages = chatMessages.querySelectorAll('.message.ai .message-bubble');
        const lastReport = lastAiMessages[lastAiMessages.length - 1];
        if (!lastReport) return;

        const reportText = lastReport.innerText || lastReport.textContent;

        // Visual separator
        const separator = document.createElement('div');
        separator.className = 'phase-separator';
        separator.innerHTML = `
            <div class="separator-line"></div>
            <span class="separator-text">🎓 进入深度学习模式</span>
            <div class="separator-line"></div>
        `;
        chatMessages.appendChild(separator);

        // Save separator
        if (currentSession) {
            currentSession.messages.push({ role: 'separator', text: '🎓 进入深度学习模式' });
        }

        statusText.textContent = '学习执行阶段';
        btnSwitchEngine.style.display = 'none';

        // Switch AI to engine mode
        window.aiService.switchToEngine(reportText);

        // Let the engine generate learning materials
        const typingMsg = addMessage('ai', null, true);
        isStreaming = true;

        try {
            let fullText = '';
            await window.aiService.sendMessage('请根据上面的最终报告，立即为我生成当前 Level 的【单次迭代教材】。', (chunk, full) => {
                fullText = full;
                updateStreamingBubble(typingMsg, fullText);
            });
            finalizeStreamingBubble(typingMsg, fullText);

            // Save
            if (currentSession) {
                currentSession.phase = 'engine';
                currentSession.messages.push({ role: 'ai', content: fullText });
                saveCurrentSession();
            }
        } catch (err) {
            removeMessage(typingMsg);
            if (err.name !== 'AbortError') {
                showToast(err.message);
            }
        } finally {
            isStreaming = false;
        }
    }

    // ====== MESSAGE RENDERING ======

    function addMessage(role, content, isTyping = false) {
        const msg = document.createElement('div');
        msg.className = `message ${role}`;

        const avatarIcon = role === 'ai' ? 'psychology' : 'person';
        msg.innerHTML = `
            <div class="message-avatar">
                <span class="material-symbols-rounded">${avatarIcon}</span>
            </div>
            <div class="message-bubble">
                ${isTyping
                ? '<div class="typing-indicator"><span></span><span></span><span></span></div>'
                : md.render(content)
            }
            </div>
        `;

        chatMessages.appendChild(msg);
        scrollToBottom();
        return msg;
    }

    function updateStreamingBubble(msgEl, text) {
        const bubble = msgEl.querySelector('.message-bubble');
        bubble.innerHTML = md.render(text);
        scrollToBottom();
    }

    function finalizeStreamingBubble(msgEl, text) {
        const bubble = msgEl.querySelector('.message-bubble');
        bubble.innerHTML = md.render(text);
        scrollToBottom();
    }

    function removeMessage(msgEl) {
        if (msgEl && msgEl.parentNode) {
            msgEl.parentNode.removeChild(msgEl);
        }
    }

    function scrollToBottom() {
        requestAnimationFrame(() => {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        });
    }

    // ====== INPUT HANDLING ======

    chatInput.addEventListener('input', () => {
        autoResizeInput();
        btnSend.disabled = !chatInput.value.trim();
    });

    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendUserMessage();
        }
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
