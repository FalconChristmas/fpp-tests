'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPORT_TEMPLATE_FILE = path.join(
	__dirname,
	'..',
	'templates',
	'visual-comparison-report.html'
);

class VisualComparisonReporter {
	constructor () {
		this.entries = [];
		this.suiteTotal = 0;
		this.outputFolder = path.join(process.cwd(), 'playwright-report');
		this.dataFile = path.join(this.outputFolder, 'report-data.json');
		this.indexFile = path.join(this.outputFolder, 'sightline.html');
	}

	onBegin (_config, suite) {
		this.suiteTotal = suite.allTests().length;
		fs.mkdirSync(this.outputFolder, { recursive: true });

		if (process.env.PW_PARTIAL === '1') {
			try {
				const raw = fs.readFileSync(this.dataFile, 'utf8');
				const report = JSON.parse(raw);
				this.entries = report.entries || [];
			} catch {
				this.entries = [];
			}
		} else {
			this.entries = [];
		}

		this.writeReportFiles();
	}

	onTestEnd (test, result) {
		const attachments = new Map();
		for (const attachment of result.attachments) {
			attachments.set(attachment.name, attachment);
		}

		const projectName = test.parent.project()?.name ?? '';
		const isLight = projectName.includes('light');
		const isDark = projectName.includes('dark');
		const screenshot = this.resolveDataPath(attachments.get('screenshot'));

		const existingEntry = this.entries.find(e => e.title === test.title);

		const newEntry = {
			title: test.title,
			status: result.status,
			durationMs: result.duration,
			updatedAt: new Date().toISOString(),
			error: summarizeErrors(result.errors),
			light: isLight ? screenshot : (existingEntry?.light ?? null),
			dark: isDark ? screenshot : (existingEntry?.dark ?? null),
		};

		const idx = this.entries.findIndex(e => e.title === test.title);
		if (idx !== -1) {
			this.entries[idx] = newEntry;
		} else {
			this.entries.push(newEntry);
		}

		this.writeReportFiles();
	}

	onEnd () {
		this.writeReportFiles();
	}

	resolveDataPath (attachment) {
		if (!attachment?.path) return null;
		const content = fs.readFileSync(attachment.path);
		const hash = crypto.createHash('sha1').update(content).digest('hex');
		const ext = path.extname(attachment.path) || '.png';
		return `data/${hash}${ext}`;
	}

	writeReportFiles () {
		this.entries.sort((a, b) => a.title.localeCompare(b.title));
		const completed = this.entries.length;
		const passed = this.entries.filter(
			entry => entry.status === 'passed'
		).length;
		const failed = this.entries.filter(entry =>
			isFailureStatus(entry.status)
		).length;

		const reportData = {
			generatedAt: new Date().toISOString(),
			total: this.suiteTotal,
			completed,
			passed,
			failed,
			entries: this.entries
		};

		fs.writeFileSync(this.dataFile, JSON.stringify(reportData, null, 2));
		fs.writeFileSync(this.indexFile, renderHtml(reportData));
	}
}

function renderHtml (report) {
	const template = fs.readFileSync(REPORT_TEMPLATE_FILE, 'utf8');
	const entriesHtml = report.entries
		.map((entry, index) => {
			return `
        <article class="card">
          <div class="card-head">
            <div class="card-title">${escapeHtml(entry.title)}</div>
            <div class="card-meta">${entry.status} • ${formatDuration(
				entry.durationMs
			)}</div>
          </div>
          <div class="preview">
            <section class="pane">
              <div class="pane-label">
                <span>Light Mode</span>
                <button type="button" class="focus" data-open="${index}">Focus</button>
              </div>
              <button type="button" class="preview-trigger" data-open="${index}">
                <img src="${escapeHtml(entry.light)}" alt="${escapeHtml(
				entry.title
			)} light mode preview" loading="lazy">
              </button>
            </section>
            <section class="pane">
              <div class="pane-label">
                <span>Dark Mode</span>
                <button type="button" data-open="${index}">Focus</button>
              </div>
              <button type="button" class="preview-trigger" data-open="${index}">
                <img src="${escapeHtml(entry.dark)}" alt="${escapeHtml(
				entry.title
			)} dark mode preview" loading="lazy">
              </button>
            </section>
          </div>
        </article>
      `;
		})
		.join('');

	return renderTemplate(template, {
		pageTitle: 'Sightline',
		totalCaptures: `${report.total} captures`,
		passedCaptures: `${report.passed} passed`,
		generatedAt: new Date(report.generatedAt).toLocaleString(),
		entriesHtml,
		reportJson: JSON.stringify(report)
	});
}

function renderTemplate (template, variables) {
	return template.replace(
		/\{\{\{\s*([a-zA-Z0-9_]+)\s*\}\}\}|\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
		(match, rawKey, escapedKey) => {
			const key = rawKey || escapedKey;
			if (!Object.prototype.hasOwnProperty.call(variables, key)) return '';
			return rawKey
				? String(variables[key])
				: escapeHtml(String(variables[key]));
		}
	);
}

function escapeHtml (value) {
	return String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function formatDuration (ms) {
	if (ms < 1000) {
		return `${ms} ms`;
	}
	return `${(ms / 1000).toFixed(1)} s`;
}

function isFailureStatus (status) {
	return ['failed', 'timedOut', 'interrupted'].includes(status);
}

function summarizeErrors (errors) {
	if (!errors || !errors.length) return null;
	return errors
		.map(error => firstLine(error.message || error.value || 'Unknown error'))
		.filter(Boolean)
		.join(' | ');
}

function firstLine (value) {
	return String(value).split('\n')[0].trim();
}

module.exports = VisualComparisonReporter;
