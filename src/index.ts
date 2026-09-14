import express from "express";
import type { Request, Response } from "express";
import { loadConfig } from "./config.js";
import { setupAuth, requireAuth } from "./middleware/auth.js";
import { buildRetrospective } from "./tools/buildRetrospective.js";
import { getOngoingEpics, getEpicAndIssues, getAllProjects, getCompletedIssuesWithCycleTime, getOpenTicketCount } from "./integrations/jira.js";
import { getRetrospective, getRetrospectivesByProject, loadRetrospectives, saveRetrospective } from "./storage.js";
import { groupByQuarter } from "./domain/history.js";
import { sendSlackNotification } from "./integrations/slack.js";
import { calculateCycleTimesForIssues, aggregateByWeek, aggregateByBiWeek, aggregateByMonth, computeProjectAverageCycleTime } from "./domain/analytics.js";
import { computeAnticipatedCompletionDate, formatDateMMDDYYYY } from "./domain/anticipatedCompletion.js";
import { fetchAllTeamMetrics } from "./domain/estimation.js";

async function main() {
    const config = await loadConfig();

    const app = express();
    app.use(express.json());

    // Auth setup - must come before routes
    setupAuth(app, {
        googleClientId: config.GOOGLE_OAUTH_CLIENT_ID,
        googleClientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET,
        sessionSecret: config.SESSION_SECRET,
        allowedEmails: config.ALLOWED_EMAILS,
        baseUrl: config.BASE_URL,
    });

    // Health check - exempt from auth so Cloud Run can probe it freely
    app.get("/health", (_req, res) => {
        res.json({ ok: true });
    });

    // All routes below require a valid Google login session
    app.use(requireAuth);

    app.get("/analytics", (_req, res) => {
        res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Analytics - Retrospective Generator</title>
        <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
        <style>
            @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
            @keyframes slideIn { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }
            @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
            * { box-sizing: border-box; }
            :root { --bg-primary: #ffffff; --bg-secondary: #f8f9fa; --bg-card: #ffffff; --text-primary: #1a1a1a; --text-secondary: #6c757d; --border-color: #e9ecef; --accent-primary: #0066ff; --accent-hover: #0052cc; --shadow: 0 2px 8px rgba(0,0,0,0.08); --shadow-hover: 0 4px 16px rgba(0,0,0,0.12); }
            [data-theme="dark"] { --bg-primary: #0d1117; --bg-secondary: #161b22; --bg-card: #1c2128; --text-primary: #e6edf3; --text-secondary: #8b949e; --border-color: #30363d; --accent-primary: #2f81f7; --accent-hover: #539bf5; --shadow: 0 2px 8px rgba(0,0,0,0.3); --shadow-hover: 0 4px 16px rgba(0,0,0,0.4); }
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1600px; margin: 0 auto; padding: 20px; background: var(--bg-primary); color: var(--text-primary); min-height: 100vh; transition: background-color 0.3s ease, color 0.3s ease; animation: fadeIn 0.6s ease-out; }
            h1 { color: var(--text-primary); margin-bottom: 8px; font-size: 32px; font-weight: 700; animation: slideIn 0.6s ease-out; }
            h1 + p { margin-bottom: 24px; color: var(--text-secondary); animation: slideIn 0.6s ease-out 0.1s both; font-size: 15px; }
            .nav { margin-bottom: 24px; animation: slideIn 0.6s ease-out; display: flex; justify-content: space-between; align-items: center; }
            .nav a { color: var(--text-primary); text-decoration: none; font-weight: 600; font-size: 14px; display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 8px; background: var(--bg-card); border: 1px solid var(--border-color); transition: all 0.2s ease; }
            .nav a:hover { background: var(--bg-secondary); border-color: var(--accent-primary); }
            .theme-toggle { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; padding: 8px 12px; cursor: pointer; transition: all 0.2s ease; display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 500; color: var(--text-primary); }
            .theme-toggle:hover { background: var(--bg-secondary); border-color: var(--accent-primary); }
            .controls { background: var(--bg-card); border: 1px solid var(--border-color); padding: 20px; border-radius: 12px; margin-bottom: 24px; box-shadow: var(--shadow); display: flex; align-items: center; gap: 16px; flex-wrap: wrap; animation: slideIn 0.6s ease-out 0.2s both; }
            .controls label { font-size: 14px; font-weight: 600; color: var(--text-primary); }
            select, button { padding: 10px 16px; font-size: 14px; border-radius: 8px; border: 1px solid var(--border-color); transition: all 0.2s ease; font-family: inherit; }
            select { background: var(--bg-card); color: var(--text-primary); cursor: pointer; min-width: 180px; }
            select:hover { border-color: var(--accent-primary); }
            select:focus { outline: none; border-color: var(--accent-primary); box-shadow: 0 0 0 3px rgba(0,102,255,0.1); }
            button { background: var(--accent-primary); color: white; border: none; cursor: pointer; font-weight: 600; }
            button:hover { background: var(--accent-hover); transform: translateY(-1px); }
            button:active { transform: translateY(0); }
            .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 20px; }
            @media (max-width: 900px) { .charts-grid { grid-template-columns: 1fr; } }
            .chart-container { background: var(--bg-card); border: 1px solid var(--border-color); padding: 20px; border-radius: 12px; box-shadow: var(--shadow); transition: all 0.2s ease; animation: fadeIn 0.5s ease-out backwards; }
            .chart-container:nth-child(1) { animation-delay: 0.8s; }
            .chart-container:nth-child(2) { animation-delay: 0.9s; }
            .chart-container:nth-child(3) { animation-delay: 1s; }
            .chart-container:hover { transform: translateY(-2px); box-shadow: var(--shadow-hover); border-color: var(--accent-primary); }
            .chart-container h2 { margin-top: 0; margin-bottom: 16px; color: var(--text-primary); font-size: 16px; font-weight: 700; }
            .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 20px; margin-bottom: 25px; }
            .stat-card { background: var(--bg-card); border: 1px solid var(--border-color); padding: 20px; border-radius: 12px; box-shadow: var(--shadow); transition: all 0.2s ease; animation: fadeIn 0.5s ease-out backwards; }
            .stat-card:nth-child(1) { animation-delay: 0.4s; } .stat-card:nth-child(2) { animation-delay: 0.5s; } .stat-card:nth-child(3) { animation-delay: 0.6s; } .stat-card:nth-child(4) { animation-delay: 0.7s; }
            .stat-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-hover); border-color: var(--accent-primary); }
            .stat-value { font-size: 32px; font-weight: 700; color: var(--accent-primary); margin-bottom: 6px; }
            .stat-label { color: var(--text-secondary); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
            .loading { text-align: center; padding: 60px 20px; color: var(--text-secondary); font-size: 18px; font-weight: 600; animation: pulse 2s infinite; }
            .error { color: #de350b; padding: 20px; background: white; border-radius: 16px; font-weight: 600; box-shadow: 0 4px 20px rgba(222,53,11,0.2); border-left: 4px solid #de350b; }
        </style>
    </head>
    <body>
        <div class="nav">
            <a href="#" id="backLink">← Back to Retrospectives</a>
            <div style="display:flex;gap:12px;align-items:center;">
                <a href="#" id="historyLink" style="color:var(--text-primary);text-decoration:none;font-weight:600;font-size:14px;display:inline-flex;align-items:center;gap:8px;padding:8px 16px;border-radius:8px;background:var(--bg-card);border:1px solid var(--border-color);transition:all 0.2s ease;">📚 History</a>
                <a href="/estimation" style="color:var(--text-primary);text-decoration:none;font-weight:600;font-size:14px;display:inline-flex;align-items:center;gap:8px;padding:8px 16px;border-radius:8px;background:var(--bg-card);border:1px solid var(--border-color);transition:all 0.2s ease;">🧮 Estimation</a>
                <button class="theme-toggle" onclick="toggleTheme()">
                    <span id="theme-icon">🌙</span>
                    <span id="theme-text">Dark</span>
                </button>
            </div>
        </div>
        <h1>📊 Cycle Time Analytics</h1>
        <p style="font-size: 14px;">Historical performance metrics for your teams</p>
        <div class="controls">
            <label for="projectSelect">Select Project:</label>
            <select id="projectSelect"><option value="">Loading projects...</option></select>
            <label for="daysBackSelect">Time Period:</label>
            <select id="daysBackSelect">
                <option value="30" selected>Last 30 days</option>
                <option value="60">Last 60 days</option>
                <option value="90">Last 90 days</option>
                <option value="180">Last 180 days</option>
                <option value="365">Last year</option>
            </select>
            <button onclick="loadAnalytics()">Load Analytics</button>
        </div>
        <div id="stats-container"></div>
        <div id="charts-container"></div>
        <script>
            const API_BASE = window.location.origin;
            function toggleTheme() {
                const newTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
                document.documentElement.setAttribute('data-theme', newTheme);
                localStorage.setItem('theme', newTheme);
                updateThemeButton(newTheme);
            }
            function updateThemeButton(theme) {
                document.getElementById('theme-icon').textContent = theme === 'dark' ? '☀️' : '🌙';
                document.getElementById('theme-text').textContent = theme === 'dark' ? 'Light' : 'Dark';
            }
            function initTheme() {
                const savedTheme = localStorage.getItem('theme') || 'light';
                document.documentElement.setAttribute('data-theme', savedTheme);
                updateThemeButton(savedTheme);
            }
            async function loadProjects() {
                try {
                    const response = await fetch(\`\${API_BASE}/api/projects\`);
                    const projects = await response.json();
                    const select = document.getElementById('projectSelect');
                    select.innerHTML = projects.map(p => \`<option value="\${p.key}">\${p.name} (\${p.key})</option>\`).join('');
                    const urlParams = new URLSearchParams(window.location.search);
                    const projectParam = urlParams.get('project');
                    if (projectParam && projects.some(p => p.key === projectParam)) select.value = projectParam;
                    updateNavLinks();
                    if (projects.length > 0) loadAnalytics();
                } catch (error) {
                    document.getElementById('charts-container').innerHTML = '<div class="error">Error loading projects</div>';
                }
            }
            function updateNavLinks() {
                const project = document.getElementById('projectSelect').value;
                document.getElementById('backLink').href = \`/?project=\${project}\`;
                document.getElementById('historyLink').href = \`/history?project=\${project}\`;
            }
            document.getElementById('projectSelect').addEventListener('change', updateNavLinks);
            async function loadAnalytics() {
                const projectKey = document.getElementById('projectSelect').value;
                const daysBack = document.getElementById('daysBackSelect').value;
                updateNavLinks();
                document.getElementById('stats-container').innerHTML = '<div class="loading">📈 Loading analytics...</div>';
                document.getElementById('charts-container').innerHTML = '';
                try {
                    const response = await fetch(\`\${API_BASE}/api/analytics?project=\${projectKey}&daysBack=\${daysBack}\`);
                    const data = await response.json();
                    if (!response.ok) throw new Error(data.error || 'Failed to load analytics');
                    displayStats(data);
                    displayCharts(data);
                } catch (error) {
                    document.getElementById('charts-container').innerHTML = \`<div class="error">Error: \${error.message}</div>\`;
                    document.getElementById('stats-container').innerHTML = '';
                }
            }
            function displayStats(data) {
                const overallAvg = data.monthly.length > 0 ? (data.monthly.reduce((sum, m) => sum + m.average, 0) / data.monthly.length).toFixed(1) : 'N/A';
                const latestMonth = data.monthly.length > 0 ? data.monthly[data.monthly.length - 1] : null;
                document.getElementById('stats-container').innerHTML = \`
                    <div class="stats-grid">
                        <div class="stat-card"><div class="stat-value">\${data.totalIssues}</div><div class="stat-label">Completed Tasks</div></div>
                        <div class="stat-card"><div class="stat-value">\${overallAvg}</div><div class="stat-label">Avg Cycle Time (days)</div></div>
                        <div class="stat-card"><div class="stat-value">\${latestMonth ? latestMonth.average : 'N/A'}</div><div class="stat-label">Latest Month Avg</div></div>
                        <div class="stat-card"><div class="stat-value">\${latestMonth ? latestMonth.count : 'N/A'}</div><div class="stat-label">Latest Month Tasks</div></div>
                    </div>\`;
            }
            function displayCharts(data) {
                document.getElementById('charts-container').innerHTML = \`
                    <div class="charts-grid">
                        <div class="chart-container"><h2>Monthly Average Cycle Time</h2><canvas id="monthlyChart"></canvas></div>
                        <div class="chart-container"><h2>Bi-Weekly Average Cycle Time</h2><canvas id="biweeklyChart"></canvas></div>
                        <div class="chart-container"><h2>Weekly Average Cycle Time</h2><canvas id="weeklyChart"></canvas></div>
                    </div>\`;
                createChart('monthlyChart', data.monthly, 'month', 'Month');
                createChart('biweeklyChart', data.biweekly, 'period', 'Bi-Weekly Period');
                createChart('weeklyChart', data.weekly, 'week', 'Week Starting');
            }
            function createChart(canvasId, data, labelKey, labelText) {
                new Chart(document.getElementById(canvasId).getContext('2d'), {
                    type: 'line',
                    data: {
                        labels: data.map(d => d[labelKey]),
                        datasets: [
                            { label: 'Average Cycle Time (days)', data: data.map(d => d.average), borderColor: '#0052cc', backgroundColor: 'rgba(0,82,204,0.1)', tension: 0.4, fill: true },
                            { label: 'Task Count', data: data.map(d => d.count), borderColor: '#00875a', backgroundColor: 'rgba(0,135,90,0.1)', tension: 0.4, yAxisID: 'y1' }
                        ]
                    },
                    options: {
                        responsive: true, maintainAspectRatio: true, aspectRatio: 2,
                        interaction: { mode: 'index', intersect: false },
                        plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 10, font: { size: 11 } } }, tooltip: { callbacks: { title: (ctx) => \`\${labelText}: \${ctx[0].label}\` } } },
                        scales: {
                            x: { ticks: { font: { size: 10 }, maxRotation: 45, minRotation: 45 } },
                            y: { type: 'linear', display: true, position: 'left', title: { display: true, text: 'Cycle Time (days)', font: { size: 11 } }, ticks: { font: { size: 10 } } },
                            y1: { type: 'linear', display: true, position: 'right', title: { display: true, text: 'Task Count', font: { size: 11 } }, ticks: { font: { size: 10 } }, grid: { drawOnChartArea: false } }
                        }
                    }
                });
            }
            window.addEventListener('DOMContentLoaded', () => { initTheme(); loadProjects(); });
        </script>
    </body>
    </html>
    `);
    });

    app.get("/", (_req, res) => {
        res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Retrospective Generator</title>
        <style>
            @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
            @keyframes slideIn { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }
            * { box-sizing: border-box; }
            :root { --bg-primary: #ffffff; --bg-secondary: #f8f9fa; --bg-card: #ffffff; --text-primary: #1a1a1a; --text-secondary: #6c757d; --border-color: #e9ecef; --accent-primary: #0066ff; --accent-hover: #0052cc; --shadow: 0 2px 8px rgba(0,0,0,0.08); --shadow-hover: 0 4px 16px rgba(0,0,0,0.12); }
            [data-theme="dark"] { --bg-primary: #0d1117; --bg-secondary: #161b22; --bg-card: #1c2128; --text-primary: #e6edf3; --text-secondary: #8b949e; --border-color: #30363d; --accent-primary: #2f81f7; --accent-hover: #539bf5; --shadow: 0 2px 8px rgba(0,0,0,0.3); --shadow-hover: 0 4px 16px rgba(0,0,0,0.4); }
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1400px; margin: 0 auto; padding: 32px 20px; background: var(--bg-primary); color: var(--text-primary); min-height: 100vh; transition: background-color 0.3s ease, color 0.3s ease; animation: fadeIn 0.6s ease-out; }
            .header-container { display: flex; justify-content: space-between; align-items: center; margin-bottom: 32px; animation: slideIn 0.6s ease-out; }
            h1 { color: var(--text-primary); margin: 0 0 8px 0; font-size: 32px; font-weight: 700; }
            .subtitle { color: var(--text-secondary); margin: 0; font-size: 15px; }
            .header-actions { display: flex; gap: 16px; align-items: center; }
            .theme-toggle { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; padding: 8px 12px; cursor: pointer; transition: all 0.3s ease; display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 500; color: var(--text-primary); }
            .theme-toggle:hover { background: var(--bg-secondary); border-color: var(--accent-primary); }
            .board-selector { margin-bottom: 32px; background: var(--bg-card); border: 1px solid var(--border-color); padding: 20px; border-radius: 12px; box-shadow: var(--shadow); animation: slideIn 0.6s ease-out 0.2s both; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
            .board-selector label { font-weight: 600; color: var(--text-primary); font-size: 14px; }
            select, button { padding: 10px 16px; font-size: 14px; border-radius: 8px; border: 1px solid var(--border-color); transition: all 0.2s ease; font-family: inherit; }
            select { min-width: 220px; background: var(--bg-card); color: var(--text-primary); cursor: pointer; }
            select:hover { border-color: var(--accent-primary); }
            select:focus { outline: none; border-color: var(--accent-primary); box-shadow: 0 0 0 3px rgba(0,102,255,0.1); }
            button { background: var(--accent-primary); color: white; border: none; cursor: pointer; font-weight: 600; }
            button:hover { background: var(--accent-hover); transform: translateY(-1px); }
            button:active { transform: translateY(0); }
            button:disabled { background: var(--text-secondary); opacity: 0.5; cursor: not-allowed; transform: none; }
            .header-link { padding: 10px 20px; background: var(--accent-primary); color: white; text-decoration: none; border-radius: 8px; font-weight: 600; transition: all 0.2s ease; display: inline-flex; align-items: center; gap: 8px; font-size: 14px; }
            .header-link:hover { background: var(--accent-hover); transform: translateY(-1px); }
            .header-link.secondary { background: var(--bg-card); color: var(--text-primary); border: 1px solid var(--border-color); }
            .header-link.secondary:hover { background: var(--bg-secondary); border-color: var(--accent-primary); }
            #epics-container { animation: fadeIn 0.6s ease-out 0.4s both; }
            .epics-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(450px, 1fr)); gap: 20px; }
            @media (max-width: 768px) { .epics-grid { grid-template-columns: 1fr; } }
            .epic-card { background: var(--bg-card); border: 1px solid var(--border-color); padding: 20px; border-radius: 12px; box-shadow: var(--shadow); transition: all 0.2s ease; animation: fadeIn 0.5s ease-out backwards; }
            .epic-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-hover); border-color: var(--accent-primary); }
            .epic-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
            .epic-key { font-weight: 700; color: var(--accent-primary); font-size: 13px; letter-spacing: 0.5px; }
            .epic-key-link, .epic-summary-link { color: inherit; text-decoration: none; transition: opacity 0.2s ease; }
            .epic-key-link:hover, .epic-summary-link:hover { opacity: 0.85; text-decoration: underline; text-underline-offset: 2px; }
            .epic-summary { font-size: 16px; color: var(--text-primary); margin-bottom: 12px; font-weight: 600; line-height: 1.5; }
            .epic-status { display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; background: var(--accent-primary); color: white; }
            .generate-btn { padding: 8px 16px; font-size: 13px; margin-top: 12px; }
            .doc-link { margin-top: 12px; padding: 12px; background: var(--bg-secondary); border-radius: 8px; border: 1px solid var(--border-color); animation: fadeIn 0.4s ease-out; }
            .doc-link strong { color: var(--text-primary); font-size: 13px; }
            .doc-link a { color: var(--accent-primary); text-decoration: none; font-weight: 600; transition: all 0.2s ease; display: inline-flex; align-items: center; gap: 6px; font-size: 14px; }
            .doc-link a:hover { color: var(--accent-hover); }
            .doc-link a::after { content: "→"; transition: transform 0.2s ease; }
            .doc-link a:hover::after { transform: translateX(3px); }
            .loading { display: inline-block; margin-left: 10px; color: var(--accent-primary); font-weight: 600; font-size: 13px; }
            .error { color: #dc3545; margin-top: 12px; padding: 12px; background: var(--bg-secondary); border: 1px solid #dc3545; border-radius: 8px; font-weight: 500; font-size: 13px; }
            .loader { text-align: center; padding: 60px 20px; color: var(--text-secondary); font-size: 16px; font-weight: 500; }
            .progress-container { margin: 12px 0; }
            .progress-bar-bg { width: 100%; height: 8px; background: var(--bg-secondary); border-radius: 4px; overflow: hidden; position: relative; }
            .progress-bar-fill { height: 100%; background: var(--accent-primary); transition: width 0.6s cubic-bezier(0.4,0,0.2,1); border-radius: 4px; }
            .progress-bar-fill.completed { background: #28a745; }
            .progress-text { font-size: 12px; color: var(--text-secondary); margin-top: 6px; font-weight: 500; }
        </style>
    </head>
    <body>
        <div class="header-container">
            <div>
                <h1>Retrospective Generator</h1>
                <p class="subtitle">Generate retrospective documents for ongoing epics</p>
            </div>
            <div class="header-actions">
                <button class="theme-toggle" onclick="toggleTheme()">
                    <span id="theme-icon">🌙</span>
                    <span id="theme-text">Dark</span>
                </button>
                <a href="#" id="historyLink" class="header-link secondary"><span>📚</span><span>History</span></a>
                <a href="/estimation" class="header-link secondary"><span>🧮</span><span>Estimation</span></a>
                <a href="#" id="analyticsLink" class="header-link"><span>📊</span><span>Analytics</span></a>
            </div>
        </div>
        <div class="board-selector">
            <label for="boardSelect">Select Project:</label>
            <select id="boardSelect"><option value="">Loading projects...</option></select>
            <button onclick="loadEpics()">Load Epics</button>
        </div>
        <div id="epics-container"></div>
        <script>
            const API_BASE = window.location.origin;
            const projectsCache = {};
            function toggleTheme() {
                const newTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
                document.documentElement.setAttribute('data-theme', newTheme);
                localStorage.setItem('theme', newTheme);
                updateThemeButton(newTheme);
            }
            function updateThemeButton(theme) {
                document.getElementById('theme-icon').textContent = theme === 'dark' ? '☀️' : '🌙';
                document.getElementById('theme-text').textContent = theme === 'dark' ? 'Light' : 'Dark';
            }
            function initTheme() {
                const savedTheme = localStorage.getItem('theme') || 'light';
                document.documentElement.setAttribute('data-theme', savedTheme);
                updateThemeButton(savedTheme);
            }
            async function loadProjects() {
                try {
                    const response = await fetch(\`\${API_BASE}/api/projects\`);
                    const projects = await response.json();
                    const select = document.getElementById('boardSelect');
                    select.innerHTML = projects.map(p => \`<option value="\${p.key}">\${p.name} (\${p.key})</option>\`).join('');
                    projects.forEach(p => { projectsCache[p.key] = p.name; });
                    const urlParams = new URLSearchParams(window.location.search);
                    const projectParam = urlParams.get('project');
                    if (projectParam && projects.some(p => p.key === projectParam)) select.value = projectParam;
                    updateNavLinks();
                    if (projects.length > 0) { loadEpics(); }
                } catch (error) {
                    document.getElementById('boardSelect').innerHTML = '<option value="">Error loading projects</option>';
                }
            }
            function updateNavLinks() {
                const project = document.getElementById('boardSelect').value;
                document.getElementById('analyticsLink').href = \`/analytics?project=\${project}\`;
                document.getElementById('historyLink').href = \`/history?project=\${project}\`;
            }
            document.getElementById('boardSelect').addEventListener('change', () => { updateNavLinks(); loadEpics(); });
            async function loadEpics() {
                const boardName = document.getElementById('boardSelect').value;
                const container = document.getElementById('epics-container');
                container.innerHTML = '<div class="loader">✨ Loading epics...</div>';
                try {
                    const response = await fetch(\`\${API_BASE}/api/epics?board=\${boardName}\`);
                    const epics = await response.json();
                    if (epics.length === 0) {
                        container.innerHTML = '<div style="text-align:center;padding:60px;background:white;border-radius:16px;color:#666;font-size:18px;font-weight:600;">📋 No ongoing epics found</div>';
                        return;
                    }
                    const epicsHTML = epics.map((epic, index) => {
                        const hasDoc = epic.documentUrl;
                        const buttonHtml = hasDoc ? \`
                            <button class="generate-btn" onclick="regenerateDoc('\${epic.key}', '\${boardName}', '\${epic.documentUrl}')">Regenerate Retrospective</button>
                            <span class="loading" id="loading-\${epic.key}" style="display:none;">✨ Regenerating...</span>\` : \`
                            <button class="generate-btn" onclick="generateDoc('\${epic.key}', '\${boardName}')">Generate Retrospective</button>
                            <span class="loading" id="loading-\${epic.key}" style="display:none;">✨ Generating...</span>\`;
                        const existingDoc = hasDoc ? \`
                            <div class="doc-link">
                                <strong>Retrospective Generated:</strong> \${new Date(epic.generatedAt).toLocaleString()}<br>
                                <a href="\${epic.documentUrl}" target="_blank">Open Retrospective Doc</a>
                            </div>\` : '';
                        const progress = epic.progress || { total: 0, completed: 0, percentage: 0 };
                        const progressBarClass = progress.percentage === 100 ? 'completed' : '';
                        const anticipatedDateHtml = epic.anticipatedCompletionDate
                            ? \`<div class="progress-text">Anticipated completion date: \${epic.anticipatedCompletionDate}</div>\`
                            : '';
                        const progressHtml = progress.total > 0 ? \`
                            <div class="progress-container">
                                <div class="progress-bar-bg"><div class="progress-bar-fill \${progressBarClass}" style="width:\${progress.percentage}%"></div></div>
                                <div class="progress-text">\${progress.completed} of \${progress.total} tasks completed (\${progress.percentage}%)</div>
                                \${anticipatedDateHtml}
                            </div>\` : \`<div class="progress-text">No tasks in this epic yet</div>\${anticipatedDateHtml}\`;
                        return \`
                            <div class="epic-card" id="epic-\${epic.key}" style="animation-delay:\${index * 0.1}s">
                                <div class="epic-header">
                                    <a class="epic-key epic-key-link" href="\${epic.jiraUrl}" target="_blank" rel="noopener noreferrer">\${epic.key}</a>
                                    <span class="epic-status">\${epic.status}</span>
                                </div>
                                <div class="epic-summary">
                                    <a class="epic-summary-link" href="\${epic.jiraUrl}" target="_blank" rel="noopener noreferrer">\${epic.summary}</a>
                                </div>
                                \${progressHtml}
                                \${buttonHtml}
                                <div id="result-\${epic.key}">\${existingDoc}</div>
                            </div>\`;
                    }).join('');
                    container.innerHTML = \`<div class="epics-grid">\${epicsHTML}</div>\`;
                } catch (error) {
                    container.innerHTML = \`<div class="error">Error loading epics: \${error.message}</div>\`;
                }
            }
            async function generateDoc(epicKey, boardName) {
                const loadingEl = document.getElementById(\`loading-\${epicKey}\`);
                const resultEl = document.getElementById(\`result-\${epicKey}\`);
                const button = event.target;
                button.disabled = true;
                loadingEl.style.display = 'inline';
                resultEl.innerHTML = '';
                try {
                    const response = await fetch(\`\${API_BASE}/run\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ board_name: getBoardName(boardName), epic_key: epicKey })
                    });
                    const result = await response.json();
                    if (response.ok) {
                        button.remove();
                        loadingEl.remove();
                        resultEl.innerHTML = \`<div class="doc-link"><strong>Retrospective Generated:</strong> Just now<br><a href="\${result.document}" target="_blank">Open Retrospective Doc</a></div>\`;
                    } else {
                        resultEl.innerHTML = \`<div class="error">Error: \${result.error}</div>\`;
                        loadingEl.style.display = 'none';
                        button.disabled = false;
                    }
                } catch (error) {
                    resultEl.innerHTML = \`<div class="error">Error: \${error.message}</div>\`;
                    loadingEl.style.display = 'none';
                    button.disabled = false;
                }
            }
            async function regenerateDoc(epicKey, boardName, documentUrl) {
                const loadingEl = document.getElementById(\`loading-\${epicKey}\`);
                const resultEl = document.getElementById(\`result-\${epicKey}\`);
                const button = event.target;
                button.disabled = true;
                loadingEl.style.display = 'inline';
                resultEl.innerHTML = '';
                try {
                    const response = await fetch(\`\${API_BASE}/run\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ board_name: getBoardName(boardName), epic_key: epicKey, existing_document_url: documentUrl })
                    });
                    const result = await response.json();
                    if (response.ok) {
                        loadingEl.style.display = 'none';
                        button.disabled = false;
                        resultEl.innerHTML = \`<div class="doc-link"><strong>Retrospective Regenerated:</strong> Just now<br><a href="\${result.document}" target="_blank">Open Retrospective Doc</a></div>\`;
                    } else {
                        resultEl.innerHTML = \`<div class="error">Error: \${result.error}</div>\`;
                        loadingEl.style.display = 'none';
                        button.disabled = false;
                    }
                } catch (error) {
                    resultEl.innerHTML = \`<div class="error">Error: \${error.message}</div>\`;
                    loadingEl.style.display = 'none';
                    button.disabled = false;
                }
            }
            function getBoardName(boardKey) { return projectsCache[boardKey]?.toLowerCase() || boardKey; }
            window.addEventListener('DOMContentLoaded', () => { initTheme(); loadProjects(); });
        </script>
    </body>
    </html>
    `);
    });

    app.get("/api/projects", async (_req, res) => {
        try {
            const projects = await getAllProjects();
            res.json(projects);
        } catch (err: any) {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    app.get("/api/epics", async (req, res) => {
        try {
            const board = req.query.board as string;
            if (!board) {
                res.status(400).json({ error: "Missing board query parameter" });
                return;
            }
            const [epics, avgCycleTime] = await Promise.all([
                getOngoingEpics(board),
                computeProjectAverageCycleTime(board, 90).catch((err) => {
                    console.warn(`Could not compute avg cycle time for ${board}:`, err.message);
                    return 0;
                }),
            ]);
            const epicsWithDocs = await Promise.all(
                epics.map(async (epic) => {
                    const [existing, openTicketCount] = await Promise.all([
                        getRetrospective(epic.key),
                        getOpenTicketCount(epic.key).catch((err) => {
                            console.warn(`Could not get open ticket count for ${epic.key}:`, err.message);
                            return 0;
                        }),
                    ]);
                    const completionDate = computeAnticipatedCompletionDate(
                        new Date(),
                        openTicketCount,
                        avgCycleTime
                    );
                    return {
                        ...epic,
                        jiraUrl: `${config.JIRA_BASE_URL}/browse/${epic.key}`,
                        documentUrl: existing?.documentUrl || null,
                        generatedAt: existing?.generatedAt || null,
                        anticipatedCompletionDate: completionDate ? formatDateMMDDYYYY(completionDate) : null,
                    };
                })
            );
            res.json(epicsWithDocs);
        } catch (err: any) {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    app.get("/api/analytics", async (req, res) => {
        try {
            const projectKey = req.query.project as string;
            const daysBack = parseInt(req.query.daysBack as string) || 30;
            if (!projectKey) {
                res.status(400).json({ error: "Missing project query parameter" });
                return;
            }
            console.log(`Fetching analytics for ${projectKey}, last ${daysBack} days...`);
            const completedIssues = await getCompletedIssuesWithCycleTime(projectKey, daysBack);
            console.log(`Found ${completedIssues.length} completed issues`);
            const cycleTimeData = await calculateCycleTimesForIssues(completedIssues);
            console.log(`Calculated cycle times for ${cycleTimeData.length} issues`);
            const weekly = aggregateByWeek(cycleTimeData);
            const biweekly = aggregateByBiWeek(cycleTimeData);
            const monthly = aggregateByMonth(cycleTimeData);
            res.json({ totalIssues: completedIssues.length, issuesWithCycleTime: cycleTimeData.length, weekly, biweekly, monthly });
        } catch (err: any) {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    app.get("/api/history", async (req, res) => {
        try {
            const projectKey = req.query.project as string;
            const retrospectives =
                !projectKey || projectKey === "all"
                    ? await loadRetrospectives()
                    : await getRetrospectivesByProject(projectKey);

            const grouped = groupByQuarter(retrospectives).map((group) => ({
                ...group,
                entries: group.entries.map((e) => ({
                    ...e,
                    jiraUrl: `${config.JIRA_BASE_URL}/browse/${e.epicKey}`,
                    projectName: e.boardName
                        .split(" ")
                        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                        .join(" "),
                })),
            }));

            res.json(grouped);
        } catch (err: any) {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    app.get("/history", (_req, res) => {
        res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>History - Retrospective Generator</title>
        <style>
            @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
            @keyframes slideIn { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }
            @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
            * { box-sizing: border-box; }
            :root { --bg-primary: #ffffff; --bg-secondary: #f8f9fa; --bg-card: #ffffff; --text-primary: #1a1a1a; --text-secondary: #6c757d; --border-color: #e9ecef; --accent-primary: #0066ff; --accent-hover: #0052cc; --shadow: 0 2px 8px rgba(0,0,0,0.08); --shadow-hover: 0 4px 16px rgba(0,0,0,0.12); }
            [data-theme="dark"] { --bg-primary: #0d1117; --bg-secondary: #161b22; --bg-card: #1c2128; --text-primary: #e6edf3; --text-secondary: #8b949e; --border-color: #30363d; --accent-primary: #2f81f7; --accent-hover: #539bf5; --shadow: 0 2px 8px rgba(0,0,0,0.3); --shadow-hover: 0 4px 16px rgba(0,0,0,0.4); }
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1400px; margin: 0 auto; padding: 32px 20px; background: var(--bg-primary); color: var(--text-primary); min-height: 100vh; transition: background-color 0.3s ease, color 0.3s ease; animation: fadeIn 0.6s ease-out; }
            .nav { margin-bottom: 24px; animation: slideIn 0.6s ease-out; display: flex; justify-content: space-between; align-items: center; }
            .nav a { color: var(--text-primary); text-decoration: none; font-weight: 600; font-size: 14px; display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 8px; background: var(--bg-card); border: 1px solid var(--border-color); transition: all 0.2s ease; }
            .nav a:hover { background: var(--bg-secondary); border-color: var(--accent-primary); }
            .theme-toggle { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; padding: 8px 12px; cursor: pointer; transition: all 0.2s ease; display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 500; color: var(--text-primary); }
            .theme-toggle:hover { background: var(--bg-secondary); border-color: var(--accent-primary); }
            h1 { color: var(--text-primary); margin: 0 0 8px 0; font-size: 32px; font-weight: 700; animation: slideIn 0.6s ease-out; }
            .subtitle { color: var(--text-secondary); margin: 0 0 28px 0; font-size: 15px; animation: slideIn 0.6s ease-out 0.1s both; }
            .controls { background: var(--bg-card); border: 1px solid var(--border-color); padding: 20px; border-radius: 12px; margin-bottom: 28px; box-shadow: var(--shadow); display: flex; align-items: center; gap: 16px; flex-wrap: wrap; animation: slideIn 0.6s ease-out 0.2s both; }
            .controls label { font-size: 14px; font-weight: 600; color: var(--text-primary); }
            select { padding: 10px 16px; font-size: 14px; border-radius: 8px; border: 1px solid var(--border-color); transition: all 0.2s ease; font-family: inherit; background: var(--bg-card); color: var(--text-primary); cursor: pointer; min-width: 220px; }
            select:hover { border-color: var(--accent-primary); }
            select:focus { outline: none; border-color: var(--accent-primary); box-shadow: 0 0 0 3px rgba(0,102,255,0.1); }
            #history-container { animation: fadeIn 0.6s ease-out 0.4s both; }
            .quarter-section { margin-bottom: 32px; animation: fadeIn 0.5s ease-out backwards; }
            .quarter-heading { font-size: 18px; font-weight: 700; color: var(--text-primary); margin: 0 0 12px 0; display: flex; align-items: center; gap: 10px; }
            .quarter-badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 700; background: var(--accent-primary); color: white; letter-spacing: 0.5px; }
            .retro-table { width: 100%; border-collapse: collapse; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px; overflow: hidden; box-shadow: var(--shadow); }
            .retro-table thead { background: var(--bg-secondary); }
            .retro-table th { padding: 12px 20px; text-align: left; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary); border-bottom: 1px solid var(--border-color); }
            .retro-table td { padding: 14px 20px; font-size: 14px; border-bottom: 1px solid var(--border-color); color: var(--text-primary); vertical-align: middle; }
            .retro-table tr:last-child td { border-bottom: none; }
            .retro-table tbody tr { transition: background 0.15s ease; }
            .retro-table tbody tr:hover { background: var(--bg-secondary); }
            .epic-title-cell a { color: var(--accent-primary); text-decoration: none; font-weight: 600; }
            .epic-title-cell a:hover { text-decoration: underline; text-underline-offset: 2px; }
            .epic-summary-cell { color: var(--text-primary); font-size: 14px; }
            .project-cell { color: var(--text-secondary); font-size: 13px; }
            .doc-link-cell a { color: var(--accent-primary); text-decoration: none; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
            .doc-link-cell a:hover { color: var(--accent-hover); text-decoration: underline; }
            .date-cell { color: var(--text-secondary); font-size: 13px; white-space: nowrap; }
            .loading { text-align: center; padding: 60px 20px; color: var(--text-secondary); font-size: 18px; font-weight: 600; animation: pulse 2s infinite; }
            .empty-state { text-align: center; padding: 60px 20px; background: var(--bg-card); border-radius: 12px; border: 1px solid var(--border-color); color: var(--text-secondary); font-size: 16px; font-weight: 500; line-height: 1.8; }
            .empty-state a { color: var(--accent-primary); font-weight: 600; text-decoration: none; }
            .empty-state a:hover { text-decoration: underline; }
            .error { color: #dc3545; padding: 20px; background: var(--bg-card); border-radius: 12px; font-weight: 600; border-left: 4px solid #dc3545; }
        </style>
    </head>
    <body>
        <div class="nav">
            <a href="#" id="backLink">← Back to Retrospectives</a>
            <div style="display:flex;gap:12px;align-items:center;">
                <a href="/estimation" style="color:var(--text-primary);text-decoration:none;font-weight:600;font-size:14px;display:inline-flex;align-items:center;gap:8px;padding:8px 16px;border-radius:8px;background:var(--bg-card);border:1px solid var(--border-color);transition:all 0.2s ease;">🧮 Estimation</a>
                <button class="theme-toggle" onclick="toggleTheme()">
                    <span id="theme-icon">🌙</span>
                    <span id="theme-text">Dark</span>
                </button>
            </div>
        </div>
        <h1>📚 Retrospective History</h1>
        <p class="subtitle">Completed retrospective documents, organised by quarter</p>
        <div class="controls">
            <label for="projectSelect">View:</label>
            <select id="projectSelect"><option value="all">All Projects</option></select>
        </div>
        <div id="history-container"></div>
        <script>
            const API_BASE = window.location.origin;
            function toggleTheme() {
                const newTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
                document.documentElement.setAttribute('data-theme', newTheme);
                localStorage.setItem('theme', newTheme);
                updateThemeButton(newTheme);
            }
            function updateThemeButton(theme) {
                document.getElementById('theme-icon').textContent = theme === 'dark' ? '☀️' : '🌙';
                document.getElementById('theme-text').textContent = theme === 'dark' ? 'Light' : 'Dark';
            }
            function initTheme() {
                const savedTheme = localStorage.getItem('theme') || 'light';
                document.documentElement.setAttribute('data-theme', savedTheme);
                updateThemeButton(savedTheme);
            }
            async function loadProjects() {
                try {
                    const response = await fetch(\`\${API_BASE}/api/projects\`);
                    const projects = await response.json();
                    const select = document.getElementById('projectSelect');
                    // "All Projects" stays as first option; append individual projects below it
                    select.innerHTML = '<option value="all">All Projects</option>' +
                        projects.map(p => \`<option value="\${p.key}">\${p.name} (\${p.key})</option>\`).join('');
                    const urlParams = new URLSearchParams(window.location.search);
                    const projectParam = urlParams.get('project');
                    if (projectParam && (projectParam === 'all' || projects.some(p => p.key === projectParam))) {
                        select.value = projectParam;
                    }
                    updateBackLink();
                    loadHistory();
                } catch (error) {
                    document.getElementById('history-container').innerHTML = '<div class="error">Error loading projects</div>';
                }
            }
            function updateBackLink() {
                const project = document.getElementById('projectSelect').value;
                document.getElementById('backLink').href = project === 'all' ? '/' : \`/?project=\${project}\`;
            }
            document.getElementById('projectSelect').addEventListener('change', () => { updateBackLink(); loadHistory(); });
            async function loadHistory() {
                const projectKey = document.getElementById('projectSelect').value;
                const isAllProjects = projectKey === 'all';
                updateBackLink();
                const container = document.getElementById('history-container');
                container.innerHTML = '<div class="loading">📚 Loading history...</div>';
                try {
                    const url = isAllProjects
                        ? \`\${API_BASE}/api/history\`
                        : \`\${API_BASE}/api/history?project=\${projectKey}\`;
                    const response = await fetch(url);
                    const quarters = await response.json();
                    if (!response.ok) throw new Error(quarters.error || 'Failed to load history');
                    if (quarters.length === 0) {
                        const backHref = isAllProjects ? '/' : \`/?project=\${projectKey}\`;
                        container.innerHTML = \`<div class="empty-state">📋 No retrospectives have been generated yet.<br>Retrospectives appear here after they are generated on the home page.<br><a href="\${backHref}">Go generate one →</a></div>\`;
                        return;
                    }
                    container.innerHTML = quarters.map((group, index) => \`
                        <div class="quarter-section" style="animation-delay:\${index * 0.1}s">
                            <h2 class="quarter-heading">
                                <span class="quarter-badge">\${group.quarter}</span>
                                <span style="font-size:14px;font-weight:500;color:var(--text-secondary)">\${group.entries.length} retrospective\${group.entries.length !== 1 ? 's' : ''}</span>
                            </h2>
                            <table class="retro-table">
                                <thead>
                                    <tr>
                                        <th>Epic</th>
                                        <th>Summary</th>
                                        \${isAllProjects ? '<th>Project</th>' : ''}
                                        <th>Date Generated</th>
                                        <th>Document</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    \${group.entries.map(entry => \`
                                        <tr>
                                            <td class="epic-title-cell"><a href="\${escapeHtml(entry.jiraUrl)}" target="_blank" rel="noopener noreferrer">\${escapeHtml(entry.epicKey)}</a></td>
                                            <td class="epic-summary-cell">\${escapeHtml(entry.epicSummary)}</td>
                                            \${isAllProjects ? \`<td class="project-cell">\${escapeHtml(entry.projectName)}</td>\` : ''}
                                            <td class="date-cell">\${formatDate(entry.generatedAt)}</td>
                                            <td class="doc-link-cell"><a href="\${entry.documentUrl}" target="_blank" rel="noopener noreferrer">Open Doc →</a></td>
                                        </tr>\`).join('')}
                                </tbody>
                            </table>
                        </div>\`).join('');
                } catch (error) {
                    container.innerHTML = \`<div class="error">Error: \${error.message}</div>\`;
                }
            }
            function formatDate(iso) {
                return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
            }
            function escapeHtml(str) {
                return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
            }
            window.addEventListener('DOMContentLoaded', () => { initTheme(); loadProjects(); });
        </script>
    </body>
    </html>
    `);
    });

    app.get("/api/estimation/metrics", async (_req, res) => {
        try {
            const metrics = await fetchAllTeamMetrics(90);
            res.json(metrics);
        } catch (err: any) {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    app.get("/estimation", (_req, res) => {
        res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Estimation - Retrospective Generator</title>
        <style>
            @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
            @keyframes slideIn { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }
            @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
            * { box-sizing: border-box; }
            :root { --bg-primary: #ffffff; --bg-secondary: #f8f9fa; --bg-card: #ffffff; --text-primary: #1a1a1a; --text-secondary: #6c757d; --border-color: #e9ecef; --accent-primary: #0066ff; --accent-hover: #0052cc; --shadow: 0 2px 8px rgba(0,0,0,0.08); --shadow-hover: 0 4px 16px rgba(0,0,0,0.12); }
            [data-theme="dark"] { --bg-primary: #0d1117; --bg-secondary: #161b22; --bg-card: #1c2128; --text-primary: #e6edf3; --text-secondary: #8b949e; --border-color: #30363d; --accent-primary: #2f81f7; --accent-hover: #539bf5; --shadow: 0 2px 8px rgba(0,0,0,0.3); --shadow-hover: 0 4px 16px rgba(0,0,0,0.4); }
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 32px 20px; background: var(--bg-primary); color: var(--text-primary); min-height: 100vh; transition: background-color 0.3s ease, color 0.3s ease; animation: fadeIn 0.6s ease-out; }
            .nav { margin-bottom: 32px; animation: slideIn 0.6s ease-out; display: flex; justify-content: space-between; align-items: center; }
            .nav-left { display: flex; gap: 12px; align-items: center; }
            .nav a { color: var(--text-primary); text-decoration: none; font-weight: 600; font-size: 14px; display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 8px; background: var(--bg-card); border: 1px solid var(--border-color); transition: all 0.2s ease; }
            .nav a:hover { background: var(--bg-secondary); border-color: var(--accent-primary); }
            .theme-toggle { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; padding: 8px 12px; cursor: pointer; transition: all 0.2s ease; display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 500; color: var(--text-primary); }
            .theme-toggle:hover { background: var(--bg-secondary); border-color: var(--accent-primary); }
            h1 { color: var(--text-primary); margin: 0 0 8px 0; font-size: 32px; font-weight: 700; animation: slideIn 0.6s ease-out; }
            h1 + p { margin: 0 0 32px 0; color: var(--text-secondary); font-size: 15px; animation: slideIn 0.6s ease-out 0.1s both; }
            .card { background: var(--bg-card); border: 1px solid var(--border-color); padding: 24px; border-radius: 12px; box-shadow: var(--shadow); margin-bottom: 20px; animation: fadeIn 0.5s ease-out backwards; }
            .card:nth-child(1) { animation-delay: 0.2s; }
            .card:nth-child(2) { animation-delay: 0.3s; }
            .input-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
            .input-row label { font-size: 15px; font-weight: 600; color: var(--text-primary); white-space: nowrap; }
            input[type="number"] { padding: 10px 16px; font-size: 18px; font-weight: 700; border-radius: 8px; border: 1px solid var(--border-color); background: var(--bg-card); color: var(--text-primary); width: 120px; transition: all 0.2s ease; font-family: inherit; }
            input[type="number"]:focus { outline: none; border-color: var(--accent-primary); box-shadow: 0 0 0 3px rgba(0,102,255,0.1); }
            .hint { font-size: 13px; color: var(--text-secondary); margin-top: 10px; }
            .result-card { background: var(--bg-card); border: 1px solid var(--border-color); padding: 28px; border-radius: 12px; box-shadow: var(--shadow); animation: fadeIn 0.4s ease-out; }
            .range-display { font-size: 48px; font-weight: 800; color: var(--accent-primary); margin-bottom: 20px; letter-spacing: -1px; }
            .case-row { display: flex; flex-direction: column; gap: 12px; }
            .case-item { display: flex; align-items: baseline; gap: 10px; padding: 14px 16px; border-radius: 8px; background: var(--bg-secondary); border: 1px solid var(--border-color); }
            .case-label { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary); white-space: nowrap; }
            .case-value { font-size: 18px; font-weight: 700; color: var(--text-primary); }
            .case-team { font-size: 13px; color: var(--text-secondary); font-style: italic; }
            .case-item.best .case-value { color: #00875a; }
            .case-item.worst .case-value { color: #de350b; }
            .floored-note { margin-top: 12px; font-size: 12px; color: var(--text-secondary); padding: 8px 12px; background: var(--bg-secondary); border-radius: 6px; border-left: 3px solid var(--accent-primary); }
            .loading { text-align: center; padding: 40px 20px; color: var(--text-secondary); font-size: 16px; font-weight: 600; animation: pulse 2s infinite; }
            .error { color: #de350b; padding: 16px; background: var(--bg-secondary); border-radius: 8px; font-weight: 600; border-left: 4px solid #de350b; }
            .placeholder { padding: 40px 20px; text-align: center; color: var(--text-secondary); font-size: 15px; }
            .metrics-note { font-size: 12px; color: var(--text-secondary); margin-top: 8px; }
        </style>
    </head>
    <body>
        <div class="nav">
            <div class="nav-left">
                <a href="/">← Back to Retrospectives</a>
                <a href="/analytics">📊 Analytics</a>
                <a href="/history">📚 History</a>
            </div>
            <button class="theme-toggle" onclick="toggleTheme()">
                <span id="theme-icon">🌙</span>
                <span id="theme-text">Dark</span>
            </button>
        </div>
        <h1>🧮 Estimation</h1>
        <p>Range estimate based on your teams' last 90 days of performance</p>

        <div class="card" id="input-card">
            <div id="metrics-status" class="loading">⏳ Loading team metrics…</div>
            <div id="input-area" style="display:none;">
                <div class="input-row">
                    <label for="taskCount">Number of tasks:</label>
                    <input type="number" id="taskCount" min="1" step="1" placeholder="e.g. 12" />
                </div>
                <p class="hint">Enter the total task count from your jira-story-decomposer dry-run breakdown.</p>
                <div id="metrics-note" class="metrics-note"></div>
            </div>
        </div>

        <div id="result-area"></div>

        <script>
            const API_BASE = window.location.origin;
            let teamMetrics = null;

            function toggleTheme() {
                const newTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
                document.documentElement.setAttribute('data-theme', newTheme);
                localStorage.setItem('theme', newTheme);
                updateThemeButton(newTheme);
            }
            function updateThemeButton(theme) {
                document.getElementById('theme-icon').textContent = theme === 'dark' ? '☀️' : '🌙';
                document.getElementById('theme-text').textContent = theme === 'dark' ? 'Light' : 'Dark';
            }
            function initTheme() {
                const savedTheme = localStorage.getItem('theme') || 'light';
                document.documentElement.setAttribute('data-theme', savedTheme);
                updateThemeButton(savedTheme);
            }

            function roundHalfUp(n) {
                const floor = Math.floor(n);
                return n - floor >= 0.5 ? floor + 1 : floor;
            }

            function computeEstimate(taskCount, metrics) {
                const included = metrics.filter(m => !m.excluded && m.avgCycleTime > 0 && m.throughput > 0);
                if (included.length === 0) return null;

                const slowest = included.reduce((a, b) => a.avgCycleTime > b.avgCycleTime ? a : b);
                const fastest = included.reduce((a, b) => a.throughput > b.throughput ? a : b);

                const high = taskCount * slowest.avgCycleTime;
                let low = taskCount / fastest.throughput;

                const floorValue = Math.min(...included.map(m => m.avgCycleTime));
                const floored = low < floorValue;
                if (floored) low = floorValue;

                return {
                    low: roundHalfUp(low),
                    high: roundHalfUp(high),
                    lowTeam: fastest.projectKey,
                    highTeam: slowest.projectKey,
                    floored
                };
            }

            function updateResult() {
                const resultArea = document.getElementById('result-area');
                const rawValue = document.getElementById('taskCount').value;
                const taskCount = parseInt(rawValue, 10);

                if (!rawValue || isNaN(taskCount) || taskCount < 1) {
                    resultArea.innerHTML = '<div class="result-card"><div class="placeholder">Enter a task count above to see the estimate.</div></div>';
                    return;
                }

                const result = computeEstimate(taskCount, teamMetrics);
                if (!result) {
                    resultArea.innerHTML = '<div class="result-card"><div class="error">No team data available to compute an estimate.</div></div>';
                    return;
                }

                const flooredNote = result.floored
                    ? '<div class="floored-note">⚠️ Best-case was raised to the floor value (fastest single-ticket cycle time across teams), since the raw calculation produced a sub-cycle-time estimate.</div>'
                    : '';

                resultArea.innerHTML = \`
                    <div class="result-card">
                        <div class="range-display">\${result.low}–\${result.high} days</div>
                        <div class="case-row">
                            <div class="case-item best">
                                <span class="case-label">Best case</span>
                                <span class="case-value">\${result.low} days</span>
                                <span class="case-team">if \${result.lowTeam} team takes it</span>
                            </div>
                            <div class="case-item worst">
                                <span class="case-label">Worst case</span>
                                <span class="case-value">\${result.high} days</span>
                                <span class="case-team">if \${result.highTeam} team takes it</span>
                            </div>
                        </div>
                        \${flooredNote}
                    </div>\`;
            }

            async function loadMetrics() {
                const statusEl = document.getElementById('metrics-status');
                const inputArea = document.getElementById('input-area');
                try {
                    const response = await fetch(\`\${API_BASE}/api/estimation/metrics\`);
                    if (!response.ok) throw new Error('Failed to load team metrics');
                    teamMetrics = await response.json();

                    const included = teamMetrics.filter(m => !m.excluded);
                    const excluded = teamMetrics.filter(m => m.excluded);
                    let noteText = \`Metrics loaded from \${included.length} team\${included.length !== 1 ? 's' : ''} (last 90 days)\`;
                    if (excluded.length > 0) {
                        noteText += \` · \${excluded.map(m => m.projectKey).join(', ')} excluded (insufficient data)\`;
                    }
                    document.getElementById('metrics-note').textContent = noteText;

                    statusEl.style.display = 'none';
                    inputArea.style.display = 'block';

                    document.getElementById('result-area').innerHTML =
                        '<div class="result-card"><div class="placeholder">Enter a task count above to see the estimate.</div></div>';

                    document.getElementById('taskCount').addEventListener('input', updateResult);
                } catch (err) {
                    statusEl.classList.remove('loading');
                    statusEl.innerHTML = \`<div class="error">Error: \${err.message}</div>\`;
                }
            }

            window.addEventListener('DOMContentLoaded', () => { initTheme(); loadMetrics(); });
        </script>
    </body>
    </html>
    `);
    });

    app.post("/run", async (req, res) => {
        try {
            const { board_name, epic_key, existing_document_url } = req.body;

            if (existing_document_url !== undefined) {
                const stored = await getRetrospective(epic_key);
                if (!stored || stored.documentUrl !== existing_document_url) {
                    res.status(400).json({ error: "existing_document_url does not match the stored retrospective for this epic" });
                    return;
                }
            }

            const result = await buildRetrospective({
                board_name,
                epic_key,
                config,
                existingDocumentUrl: existing_document_url,
            });
            const { epic } = await getEpicAndIssues(epic_key);
            const epicSummary: string = epic.fields.summary;
            await saveRetrospective(epic_key, board_name, result.document, epicSummary);
            await sendSlackNotification({
                epicKey: epic_key,
                epicSummary: epic.fields.summary,
                documentUrl: result.document,
                boardName: board_name,
            });
            res.json(result);
        } catch (err: any) {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    app.listen(config.PORT, () => {
        console.log(`Server running on port ${config.PORT}`);
    });
}

main().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
});