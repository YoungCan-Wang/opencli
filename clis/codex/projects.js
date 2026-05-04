import { cli, Strategy } from '@jackwener/opencli/registry';
import { flattenCodexProjects, readCodexProjects } from './sidebar.js';

export const projectsCommand = cli({
    site: 'codex',
    name: 'projects',
    access: 'read',
    description: 'List Codex projects and visible conversations from the sidebar',
    domain: 'localhost',
    strategy: Strategy.UI,
    browser: true,
    args: [
        { name: 'project', required: false, help: 'Filter by project label or path' },
        { name: 'limit', required: false, help: 'Max conversations per project' },
    ],
    columns: ['Project', 'Index', 'Title', 'Updated', 'Active'],
    func: async (page, kwargs) => {
        const projects = await readCodexProjects(page);
        const rows = flattenCodexProjects(projects, kwargs);
        if (rows.length === 0) {
            return [{ Project: kwargs.project || '', Index: 0, Title: 'No Codex projects found', Updated: '', Active: '' }];
        }
        return rows;
    },
});
