import { describe, expect, it } from 'vitest';
import {
    collectCodexProjectsFromDocument,
    flattenCodexProjects,
    selectCodexConversationInDocument,
} from './sidebar.js';

class FakeElement {
    constructor(tagName = 'div', attrs = {}, children = [], text = '') {
        this.tagName = tagName.toUpperCase();
        this.attrs = attrs;
        this.children = children;
        this.parentElement = null;
        this.textContent = text;
        this.innerText = text;
        this.className = attrs.class || '';
        this.listeners = new Map();
        for (const child of children) {
            child.parentElement = this;
        }
    }

    getAttribute(name) {
        return this.attrs[name] ?? null;
    }

    addEventListener(name, fn) {
        const listeners = this.listeners.get(name) || [];
        listeners.push(fn);
        this.listeners.set(name, listeners);
    }

    click() {
        for (const listener of this.listeners.get('click') || []) {
            listener();
        }
    }

    scrollIntoView() {
    }

    closest(selector) {
        let current = this;
        while (current) {
            if (matchesSelector(current, selector))
                return current;
            current = current.parentElement;
        }
        return null;
    }

    querySelectorAll(selector) {
        const selectors = selector.split(',').map(part => part.trim());
        const results = [];
        const visit = (node) => {
            if (selectors.some(part => matchesSelector(node, part))) {
                results.push(node);
            }
            for (const child of node.children) {
                visit(child);
            }
        };
        for (const child of this.children) {
            visit(child);
        }
        return results;
    }
}

function matchesSelector(node, selector) {
    if (selector === '[data-app-action-sidebar-project-row]') {
        return node.getAttribute('data-app-action-sidebar-project-row') !== null;
    }
    if (selector === '[data-app-action-sidebar-thread-row]') {
        return node.getAttribute('data-app-action-sidebar-thread-row') !== null;
    }
    if (selector === '[role="listitem"][aria-label]') {
        return node.getAttribute('role') === 'listitem' && node.getAttribute('aria-label') !== null;
    }
    if (selector === '.tabular-nums') {
        return String(node.className || '').split(/\s+/).includes('tabular-nums');
    }
    if (selector === '[class*="tabular-nums"]') {
        return String(node.className || '').includes('tabular-nums');
    }
    if (selector === '[class*="description"]') {
        return String(node.className || '').includes('description');
    }
    return false;
}

function el(tagName, attrs, children = [], text = '') {
    return new FakeElement(tagName, attrs, children, text);
}

function thread(attrs, title, updated) {
    return el('div', {
        role: 'button',
        'data-app-action-sidebar-thread-row': '',
        'data-app-action-sidebar-thread-title': title,
        'data-app-action-sidebar-thread-id': attrs.threadId,
        'data-app-action-sidebar-thread-host-id': attrs.hostId || '',
        'data-app-action-sidebar-thread-kind': attrs.kind || '',
        'data-app-action-sidebar-thread-active': attrs.active ? 'true' : 'false',
        'data-app-action-sidebar-thread-pinned': attrs.pinned ? 'true' : 'false',
    }, [
        el('span', { 'data-thread-title': '' }, [], title),
        el('span', { class: 'tabular-nums' }, [], updated),
    ], `${title} ${updated}`);
}

function project(label, projectPath, children) {
    return el('div', { role: 'listitem', 'aria-label': label }, [
        el('div', {
            role: 'button',
            'aria-expanded': 'true',
            'data-app-action-sidebar-project-row': '',
            'data-app-action-sidebar-project-label': label,
            'data-app-action-sidebar-project-id': projectPath,
        }, [], label),
        ...children,
    ]);
}

function fixtureDocument() {
    return el('document', {}, [
        project('stock', '/Users/youngcan/stock', [
            thread({ threadId: 'local:stock-sync', hostId: 'local', kind: 'local', active: true }, '同步各仓库最新代码', '4 小时'),
            thread({ threadId: 'local:trading-agents' }, '借鉴 TradingAgents', '2 小时'),
        ]),
        project('opencli', '/Users/youngcan/opencli', [
            thread({ threadId: 'local:opencli-groups' }, '统一 opencli 二级命令分组', '1 天'),
        ]),
    ]);
}

describe('codex sidebar helpers', () => {
    it('collects projects and visible conversations from Codex data attributes', () => {
        const projects = collectCodexProjectsFromDocument(fixtureDocument());

        expect(projects).toHaveLength(2);
        expect(projects[0]).toMatchObject({
            project: 'stock',
            projectPath: '/Users/youngcan/stock',
            collapsed: false,
        });
        expect(projects[0].conversations[0]).toMatchObject({
            index: 1,
            title: '同步各仓库最新代码',
            updated: '4 小时',
            active: true,
            threadId: 'local:stock-sync',
        });
    });

    it('flattens project rows with project filters', () => {
        const projects = collectCodexProjectsFromDocument(fixtureDocument());
        const rows = flattenCodexProjects(projects, { project: 'opencli' });

        expect(rows).toEqual([
            expect.objectContaining({
                Project: 'opencli',
                Index: 1,
                Title: '统一 opencli 二级命令分组',
                Updated: '1 天',
            }),
        ]);
    });

    it('does not match nested project paths when filtering by a parent label', () => {
        const projects = collectCodexProjectsFromDocument(fixtureDocument());
        projects.push({
            index: 3,
            project: 'nested',
            projectPath: '/Users/youngcan/opencli/nested',
            collapsed: false,
            conversations: [
                { index: 1, title: 'Nested thread', updated: '', active: false, threadId: 'local:nested' },
            ],
        });

        const rows = flattenCodexProjects(projects, { project: 'opencli' });

        expect(rows.map(row => row.Project)).toEqual(['opencli']);
    });

    it('selects a conversation by project and title', () => {
        const doc = fixtureDocument();
        const selected = [];
        for (const row of doc.querySelectorAll('[data-app-action-sidebar-thread-row]')) {
            row.addEventListener('click', () => selected.push(row.getAttribute('data-app-action-sidebar-thread-id')));
        }

        const result = selectCodexConversationInDocument({
            project: 'stock',
            conversation: 'TradingAgents',
        }, doc);

        expect(result).toMatchObject({
            ok: true,
            selected: true,
            project: 'stock',
            conversation: '借鉴 TradingAgents',
            threadId: 'local:trading-agents',
            index: 2,
        });
        expect(selected).toEqual(['local:trading-agents']);
    });

    it('does not dispatch DOM click when native click is preferred', () => {
        const doc = fixtureDocument();
        const selected = [];
        for (const row of doc.querySelectorAll('[data-app-action-sidebar-thread-row]')) {
            row.addEventListener('click', () => selected.push(row.getAttribute('data-app-action-sidebar-thread-id')));
        }

        const result = selectCodexConversationInDocument({
            project: 'stock',
            conversation: 'TradingAgents',
            preferNativeClick: true,
        }, doc);

        expect(result).toMatchObject({
            ok: true,
            selected: true,
            threadId: 'local:trading-agents',
        });
        expect(selected).toEqual([]);
    });

    it('selects a conversation by index within a project', () => {
        const result = selectCodexConversationInDocument({
            project: '/Users/youngcan/opencli',
            index: '1',
        }, fixtureDocument());

        expect(result).toMatchObject({
            ok: true,
            project: 'opencli',
            conversation: '统一 opencli 二级命令分组',
            threadId: 'local:opencli-groups',
        });
    });
});
