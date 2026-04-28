/**
 * MonacoEditor - Lightweight Monaco Editor wrapper for file editing
 * 
 * Features:
 * - Auto language detection based on file extension
 * - Custom warm theme matching preview background
 * - Optimized for performance (minimal features enabled)
 * - Loading state handling
 * - Local bundle (no CDN) for Tauri CSP compatibility
 */
import Editor, { loader, type Monaco } from '@monaco-editor/react';
import { Loader2, Quote } from 'lucide-react';
import * as monaco from 'monaco-editor';
import { retainFocusOnMouseDown } from '@/utils/focusRetention';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
// CRITICAL: Must import Monaco CSS for styles to work in Vite bundled mode
import 'monaco-editor/min/vs/editor/editor.main.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Configure Monaco Environment for bundled workers (required for Tauri CSP)
self.MonacoEnvironment = {
    getWorker(_: unknown, label: string) {
        if (label === 'json') {
            return new jsonWorker();
        }
        if (label === 'css' || label === 'scss' || label === 'less') {
            return new cssWorker();
        }
        if (label === 'html' || label === 'handlebars' || label === 'razor') {
            return new htmlWorker();
        }
        if (label === 'typescript' || label === 'javascript') {
            return new tsWorker();
        }
        return new editorWorker();
    }
};

// Configure Monaco to use local bundle instead of CDN
loader.config({ monaco });

// Custom theme names
const LIGHT_THEME_NAME = 'warmLight';
const DARK_THEME_NAME = 'warmDark';

// Re-export language utilities from shared module for backward compatibility
export { getMonacoLanguage, shouldShowLineNumbers } from '@/utils/languageUtils';

/** Selection payload emitted by `onQuote`. Lines are already trimmed of leading/trailing
 *  blank-only lines and `endLine` is decremented when the selection ends at column 1
 *  (i.e. user dragged to the start of the next line but didn't include any text from it). */
export interface MonacoQuoteSelection {
    text: string;
    startLine: number;
    endLine: number;
}

interface MonacoEditorProps {
    value: string;
    onChange: (value: string) => void;
    language?: string;
    readOnly?: boolean;
    className?: string;
    /** Auto focus the editor when mounted */
    autoFocus?: boolean;
    /** Cmd/Ctrl+S handler — registered as Monaco keybinding */
    onSave?: () => void;
    /** Initial line to scroll to and select */
    initialLineNumber?: number;
    /** When provided, a floating「引用」button appears above any non-empty selection.
     *  Clicking it calls back with the selection's text + 1-based line range, then clears
     *  the selection. When omitted, no quote affordance is rendered (Monaco-side default). */
    onQuote?: (selection: MonacoQuoteSelection) => void;
}

export default function MonacoEditor({
    value,
    onChange,
    language = 'plaintext',
    readOnly = false,
    className = '',
    autoFocus = false,
    onSave,
    initialLineNumber,
    onQuote,
}: MonacoEditorProps) {
    const handleChange = useCallback((newValue: string | undefined) => {
        onChange(newValue ?? '');
    }, [onChange]);

    // Register custom theme in beforeMount using the callback's monaco instance
    // This ensures we're defining the theme on the exact instance the Editor will use
    // Colors are aligned with Prism oneLight theme for consistency between preview and edit modes
    // Detect dark mode from <html> class and watch for changes
    const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));

    useEffect(() => {
        const htmlEl = document.documentElement;
        const observer = new MutationObserver(() => {
            setIsDark(htmlEl.classList.contains('dark'));
        });
        observer.observe(htmlEl, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);

    const activeTheme = isDark ? DARK_THEME_NAME : LIGHT_THEME_NAME;

    const handleBeforeMount = useCallback((monacoInstance: Monaco) => {
        monacoInstance.editor.defineTheme(LIGHT_THEME_NAME, {
            base: 'vs',
            inherit: true,
            rules: [
                // Prism oneLight colors (with warm background adaptation)
                { token: 'comment', foreground: '9ea1a7', fontStyle: 'italic' },  // hsl(230, 4%, 64%)
                { token: 'keyword', foreground: 'a626a4' },                        // hsl(301, 63%, 40%) - purple
                { token: 'keyword.control', foreground: 'a626a4' },
                { token: 'storage', foreground: 'a626a4' },
                { token: 'storage.type', foreground: 'a626a4' },
                { token: 'string', foreground: '50a14f' },                         // hsl(119, 34%, 47%) - green
                { token: 'string.quoted', foreground: '50a14f' },
                { token: 'number', foreground: 'b76b01' },                         // hsl(35, 99%, 36%) - orange
                { token: 'constant', foreground: 'b76b01' },
                { token: 'constant.numeric', foreground: 'b76b01' },
                { token: 'type', foreground: 'b76b01' },                           // class-name color
                { token: 'type.identifier', foreground: 'b76b01' },
                { token: 'class', foreground: 'b76b01' },
                { token: 'function', foreground: '4078f2' },                       // hsl(221, 87%, 60%) - blue
                { token: 'function.call', foreground: '4078f2' },
                { token: 'variable', foreground: '4078f2' },
                { token: 'variable.other', foreground: '4078f2' },
                { token: 'operator', foreground: '4078f2' },
                { token: 'tag', foreground: 'e45649' },                            // hsl(5, 74%, 59%) - red
                { token: 'attribute.name', foreground: 'b76b01' },
                { token: 'attribute.value', foreground: '50a14f' },
                { token: 'delimiter', foreground: '383a42' },                      // punctuation
                { token: 'delimiter.bracket', foreground: '383a42' },
            ],
            colors: {
                // Editor background - matching preview warm tone
                'editor.background': '#f8f5ef',
                'editor.foreground': '#383a42',  // Prism oneLight foreground
                'editor.lineHighlightBackground': '#f3f0ea',
                'editor.selectionBackground': '#e5e5e6',  // hsl(230, 1%, 90%)
                'editor.inactiveSelectionBackground': '#f0ede6',
                // Line numbers
                'editorLineNumber.foreground': '#9ea1a7',  // match comment color
                'editorLineNumber.activeForeground': '#383a42',
                // Scrollbar - subtle to match preview
                'scrollbar.shadow': '#00000000',
                'scrollbarSlider.background': '#c8b8a840',
                'scrollbarSlider.hoverBackground': '#b8a08860',
                'scrollbarSlider.activeBackground': '#a0906880',
                // Gutter and margins - matching preview exactly
                'editorGutter.background': '#f8f5ef',
                // Cursor
                'editorCursor.foreground': '#383a42',
                // Indent guides
                'editorIndentGuide.background': '#e8e4db',
                'editorIndentGuide.activeBackground': '#d8d4cb',
            }
        });

        monacoInstance.editor.defineTheme(DARK_THEME_NAME, {
            base: 'vs-dark',
            inherit: true,
            rules: [
                // oneDark-inspired colors adapted for warm dark theme
                { token: 'comment', foreground: '685c52', fontStyle: 'italic' },  // --code-line-number
                { token: 'keyword', foreground: 'c678dd' },                        // purple
                { token: 'keyword.control', foreground: 'c678dd' },
                { token: 'storage', foreground: 'c678dd' },
                { token: 'storage.type', foreground: 'c678dd' },
                { token: 'string', foreground: '98c379' },                         // green
                { token: 'string.quoted', foreground: '98c379' },
                { token: 'number', foreground: 'd19a66' },                         // orange
                { token: 'constant', foreground: 'd19a66' },
                { token: 'constant.numeric', foreground: 'd19a66' },
                { token: 'type', foreground: 'e5c07b' },                           // yellow
                { token: 'type.identifier', foreground: 'e5c07b' },
                { token: 'class', foreground: 'e5c07b' },
                { token: 'function', foreground: '61afef' },                       // blue
                { token: 'function.call', foreground: '61afef' },
                { token: 'variable', foreground: 'e06c75' },                       // red
                { token: 'variable.other', foreground: 'e06c75' },
                { token: 'operator', foreground: '56b6c2' },                       // cyan
                { token: 'tag', foreground: 'e06c75' },                            // red
                { token: 'attribute.name', foreground: 'd19a66' },
                { token: 'attribute.value', foreground: '98c379' },
                { token: 'delimiter', foreground: 'abb2bf' },                      // punctuation
                { token: 'delimiter.bracket', foreground: 'abb2bf' },
            ],
            colors: {
                // Dark warm background matching --code-bg / --paper dark vars
                'editor.background': '#141210',           // --code-bg (dark)
                'editor.foreground': '#d4d4d4',           // --code-text
                'editor.lineHighlightBackground': '#1e1a16', // --code-header-bg (dark)
                'editor.selectionBackground': '#3a342c',  // muted warm selection
                'editor.inactiveSelectionBackground': '#302a22',
                // Line numbers
                'editorLineNumber.foreground': '#685c52', // --code-line-number (dark)
                'editorLineNumber.activeForeground': '#cfc5ba', // --ink-secondary (dark)
                // Scrollbar
                'scrollbar.shadow': '#00000000',
                'scrollbarSlider.background': '#4a403840',
                'scrollbarSlider.hoverBackground': '#5a504860',
                'scrollbarSlider.activeBackground': '#6a605880',
                // Gutter
                'editorGutter.background': '#141210',
                // Cursor
                'editorCursor.foreground': '#e4dcd4',     // --ink (dark)
                // Indent guides
                'editorIndentGuide.background': '#2a2420',
                'editorIndentGuide.activeBackground': '#3a342c',
            }
        });
    }, []);

    // Stable ref for onSave to avoid re-registering keybinding on every render
    const onSaveRef = useRef(onSave);
    useEffect(() => { onSaveRef.current = onSave; }, [onSave]);

    // Stable ref for onQuote — listener is registered once at mount but caller's callback
    // identity may change across renders (e.g. when path/onQuoteSelection change in parent).
    const onQuoteRef = useRef(onQuote);
    useEffect(() => { onQuoteRef.current = onQuote; }, [onQuote]);

    // Selection-quote menu state (ignored when onQuote is undefined). Editor instance held
    // in a ref because we need to query selection at click time outside React effects.
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
    const [quoteMenu, setQuoteMenu] = useState<{ x: number; y: number; above: boolean } | null>(null);
    const quoteRafRef = useRef<number | null>(null);

    /** Compute viewport coords for the quote menu given a current non-empty selection.
     *  Mirrors SelectionCommentMenu's positioning: anchor at start of selection, prefer
     *  above; fall back below when too close to viewport top. Returns null when the
     *  selection is empty / off-screen / editor is unmounted. */
    const computeQuoteMenuPosition = useCallback((editor: monaco.editor.IStandaloneCodeEditor) => {
        const sel = editor.getSelection();
        if (!sel || sel.isEmpty()) return null;
        const editorEl = editor.getDomNode();
        if (!editorEl) return null;
        const local = editor.getScrolledVisiblePosition({
            lineNumber: sel.startLineNumber,
            column: sel.startColumn,
        });
        if (!local) return null;
        const editorRect = editorEl.getBoundingClientRect();
        const viewportX = editorRect.left + local.left;
        const viewportY = editorRect.top + local.top;
        const MENU_WIDTH = 96; // single-button menu, ~80–96px
        const MENU_HEIGHT = 36;
        const x = Math.max(8, Math.min(viewportX, window.innerWidth - MENU_WIDTH - 8));
        const showAbove = viewportY >= MENU_HEIGHT + 8;
        const y = showAbove ? viewportY : viewportY + (local.height ?? 18) + 6;
        // Clamp inside editor's vertical bounds so the menu doesn't float above the
        // toolbar / below the editor when selection is partially scrolled out of view.
        if (y < editorRect.top - MENU_HEIGHT || y > editorRect.bottom + MENU_HEIGHT) return null;
        return { x, y, above: showAbove };
    }, []);

    /** Schedule a menu update on next animation frame. RAF coalesces the storm of
     *  selection-change events emitted during a mouse drag (Monaco fires per pixel) into
     *  a single position recompute, and naturally handles keyboard selection (shift+arrow)
     *  the same way without an extra mouseup hook. Bails early when the parent didn't opt
     *  into quoting so non-chat callers (settings panels etc.) pay zero per-selection cost. */
    const scheduleQuoteMenuUpdate = useCallback(() => {
        if (!onQuoteRef.current) return;
        if (quoteRafRef.current !== null) return;
        quoteRafRef.current = requestAnimationFrame(() => {
            quoteRafRef.current = null;
            const editor = editorRef.current;
            if (!editor || !onQuoteRef.current) {
                setQuoteMenu(null);
                return;
            }
            setQuoteMenu(computeQuoteMenuPosition(editor));
        });
    }, [computeQuoteMenuPosition]);

    /** Handle a click on the floating「引用」button: pull current selection from Monaco,
     *  trim leading/trailing blank-only lines (recompute startLine/endLine to match), drop
     *  trailing line when selection ends at column 1, then deliver to caller and clear. */
    const handleQuoteClick = useCallback(() => {
        const editor = editorRef.current;
        const onQuoteFn = onQuoteRef.current;
        if (!editor || !onQuoteFn) return;
        const sel = editor.getSelection();
        const model = editor.getModel();
        if (!sel || sel.isEmpty() || !model) return;

        // If user dragged to the start of next line, the included content stops at the
        // previous line — clamp endLine accordingly so emitted range matches what they see.
        let effEndLine = sel.endLineNumber;
        let effEndColumn = sel.endColumn;
        if (sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber) {
            effEndLine = sel.endLineNumber - 1;
            effEndColumn = model.getLineMaxColumn(effEndLine);
        }

        const text = model.getValueInRange({
            startLineNumber: sel.startLineNumber,
            startColumn: sel.startColumn,
            endLineNumber: effEndLine,
            endColumn: effEndColumn,
        });

        // Trim head/tail blank-only lines & shift line range.
        const lines = text.split('\n');
        let headSkip = 0;
        while (headSkip < lines.length && lines[headSkip].trim() === '') headSkip++;
        let tailSkip = 0;
        while (tailSkip < lines.length - headSkip && lines[lines.length - 1 - tailSkip].trim() === '') tailSkip++;
        const trimmedText = lines.slice(headSkip, lines.length - tailSkip).join('\n');
        const startLine = sel.startLineNumber + headSkip;
        const endLine = effEndLine - tailSkip;

        if (!trimmedText.trim() || endLine < startLine) {
            // All blank — bail out without emitting; clear selection so the menu hides.
            editor.setSelection({ startLineNumber: sel.startLineNumber, startColumn: sel.startColumn, endLineNumber: sel.startLineNumber, endColumn: sel.startColumn });
            return;
        }

        onQuoteFn({ text: trimmedText, startLine, endLine });
        // Clear selection so the menu auto-hides.
        editor.setSelection({ startLineNumber: sel.startLineNumber, startColumn: sel.startColumn, endLineNumber: sel.startLineNumber, endColumn: sel.startColumn });
    }, []);

    // Force apply theme after mount to ensure it takes effect
    // This handles the case where beforeMount's defineTheme might not sync immediately
    // Also registers Cmd/Ctrl+S keybinding and handles autoFocus
    const handleOnMount = useCallback((editor: monaco.editor.IStandaloneCodeEditor, monacoInstance: Monaco) => {
        monacoInstance.editor.setTheme(activeTheme);
        editorRef.current = editor;

        // Register Cmd/Ctrl+S keybinding
        editor.addCommand(
            monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS,
            () => { onSaveRef.current?.(); }
        );

        // Quote-menu wiring: register once. `onQuote` is read via ref so the listener
        // doesn't need re-registration when the callback identity changes upstream.
        const disposables: monaco.IDisposable[] = [];
        disposables.push(editor.onDidChangeCursorSelection(() => { scheduleQuoteMenuUpdate(); }));
        // Reposition menu while user scrolls the editor — selection stays put, but its
        // viewport coordinates move. Without this the menu would visually detach from the
        // selection during scroll.
        disposables.push(editor.onDidScrollChange(() => { scheduleQuoteMenuUpdate(); }));
        // When the editor loses focus to a click outside (e.g. the menu button itself
        // intercepts mousedown to preserve selection), Monaco still keeps the selection.
        // No extra blur handling needed — selection-change covers clearing.
        editor.onDidDispose(() => {
            for (const d of disposables) d.dispose();
            if (editorRef.current === editor) editorRef.current = null;
        });

        if (initialLineNumber) {
            // Give it a tiny delay to ensure layout is done
            setTimeout(() => {
                editor.revealLineInCenter(initialLineNumber);
                editor.setPosition({ lineNumber: initialLineNumber, column: 1 });
            }, 50);
        }

        if (autoFocus) {
            // Use setTimeout to ensure editor is fully ready
            setTimeout(() => editor.focus(), 0);
        }
    }, [autoFocus, activeTheme, initialLineNumber, scheduleQuoteMenuUpdate]);

    // Cancel any pending RAF on unmount to avoid setState-after-unmount warning.
    useEffect(() => () => {
        if (quoteRafRef.current !== null) cancelAnimationFrame(quoteRafRef.current);
    }, []);

    // Defense for `onQuote` flipping defined → undefined mid-session: the JSX render-side
    // guard `{onQuote && quoteMenu && ...}` already hides the stale menu visually, and the
    // next `onDidChangeCursorSelection` (which fires the moment user touches the editor
    // again) overwrites `quoteMenu` with a fresh position when `onQuote` becomes defined
    // again. So no `useEffect`-based clear is needed — that would also trip the
    // `react-hooks/set-state-in-effect` rule by writing state from an effect.

    // Monaco editor options optimized for performance
    const options = useMemo(() => ({
        readOnly,
        minimap: { enabled: false },
        lineNumbers: 'on' as const,
        scrollBeyondLastLine: false,
        wordWrap: 'on' as const,
        wrappingStrategy: 'advanced' as const,
        // Disable accessibility support to fix CJK IME composition issues on WebKit/macOS.
        // When enabled, Monaco uses a different text measurement path that causes:
        // - Multi-line: entire line jumps right during pinyin composition
        // - Single-line: line bounces vertically during composition
        // See: https://github.com/microsoft/monaco-editor/issues/4270
        accessibilitySupport: 'off' as const,
        fontSize: 14,
        lineHeight: 22,
        // Use expanded font stack for Chinese character support in comments
        // Note: Monaco doesn't support CSS variables, so we inline the --font-code equivalent
        fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', 'Consolas', 'Monaco', 'Fira Code', 'PingFang SC', 'Microsoft YaHei', monospace",
        tabSize: 2,
        automaticLayout: true,
        padding: { top: 16, bottom: 16 },
        // Tighten the left gutter. `lineNumbersMinChars: 4` keeps room for up-to-9999-line
        // files without recomputing layout when the file grows; `lineDecorationsWidth: 2`
        // pulls content close to the line numbers (default 10 leaves a wasteful gap, especially
        // since `glyphMargin: false` already removed the breakpoint column).
        lineNumbersMinChars: 4,
        lineDecorationsWidth: 2,
        glyphMargin: false,
        scrollbar: {
            vertical: 'auto' as const,
            horizontal: 'auto' as const,
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
            useShadows: false,
        },
        // Disable features for performance
        folding: true,
        foldingHighlight: false,
        showFoldingControls: 'mouseover' as const,
        renderWhitespace: 'none' as const,
        guides: {
            indentation: true,
            bracketPairs: false,
        },
        bracketPairColorization: { enabled: false },
        contextmenu: false,
        dragAndDrop: false,
        quickSuggestions: false,
        suggestOnTriggerCharacters: false,
        acceptSuggestionOnEnter: 'off' as const,
        hover: { enabled: false },
        parameterHints: { enabled: false },
        // Prevent long lines (e.g., minified JSON/JS) from freezing the tokenizer
        maxTokenizationLineLength: 10000,
        // Don't highlight every occurrence of the word under the cursor — feels like
        // a flicker storm on hover/click and adds no value when LSP is disabled anyway.
        // `selectionHighlight` (default true) is kept: explicitly selecting a word still
        // highlights its other occurrences, which is a useful cross-reference.
        occurrencesHighlight: 'off' as const,
        // Tame Monaco's "ambiguous Unicode" flagging for CJK content. The default boxes
        // every full-width punctuation mark (`，` `。` `；` etc.) because they look like
        // ASCII counterparts — useless noise for Chinese notes. We keep `invisibleCharacters`
        // on (catches zero-width sneak-ins) and turn off the comments/strings inclusions.
        unicodeHighlight: {
            ambiguousCharacters: false,
            invisibleCharacters: true,
            includeComments: false,
            includeStrings: false,
        },
        // Extend wordSeparators with CJK full-width punctuation so double-click in Chinese
        // text stops at `，` `。` etc. instead of swallowing whole paragraphs. Monaco's
        // default list only includes ASCII punctuation, which never appears mid-Chinese.
        wordSeparators: '~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?，。！？；：“”‘’「」『』（）【】《》、…—·',
    }), [readOnly]);

    // Wrapper class `monaco-editor-host` is targeted by index.css to add visual right
    // padding on the wrapper itself; Monaco's `automaticLayout: true` watches the
    // wrapper's content box via ResizeObserver and lays out the editor (and its overlay
    // scrollbar) within the reduced area. Monaco's own `padding` option only supports
    // top/bottom — wrapper padding is the supported workaround for horizontal padding.
    return (
        <div className={`monaco-editor-host relative h-full w-full overflow-hidden ${className}`}>
            <Editor
                height="100%"
                language={language}
                value={value}
                onChange={handleChange}
                theme={activeTheme}
                options={options}
                beforeMount={handleBeforeMount}
                onMount={handleOnMount}
                loading={
                    <div className="flex h-full items-center justify-center gap-2 text-[var(--ink-muted)]">
                        <Loader2 className="h-5 w-5 animate-spin" />
                        <span className="text-sm">加载编辑器...</span>
                    </div>
                }
            />
            {/* Floating「引用」menu — only mounted when caller opted in via `onQuote`.
                Visual mirrors SelectionCommentMenu (`z-[300]`, same panel + button classes)
                so reading flow between assistant-message quote and file-selection quote
                stays identical. `retainFocusOnMouseDown` on both the panel and the button
                keeps Monaco's selection alive while the click registers — otherwise the
                editor steals focus on mousedown and clears the selection before
                `handleQuoteClick` can read `editor.getSelection()`. */}
            {onQuote && quoteMenu && (
                <div
                    className="fixed z-[300] flex items-center gap-0.5 rounded-lg border border-[var(--line-strong)] bg-[var(--paper-elevated)] px-1 py-0.5 shadow-md"
                    style={{
                        left: quoteMenu.x,
                        top: quoteMenu.y,
                        transform: quoteMenu.above ? 'translateY(calc(-100% - 6px))' : undefined,
                    }}
                    onMouseDown={retainFocusOnMouseDown}
                >
                    <button
                        type="button"
                        className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                        onClick={handleQuoteClick}
                        onMouseDown={retainFocusOnMouseDown}
                    >
                        <Quote className="h-3 w-3" />
                        引用
                    </button>
                </div>
            )}
        </div>
    );
}

