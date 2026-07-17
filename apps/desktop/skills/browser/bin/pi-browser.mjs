#!/usr/bin/env node

/**
 * pi-browser — CLI tool for browser automation via the Pi Coding Agent.
 *
 * This is a thin wrapper that sends HTTP requests to the local BrowserManager
 * HTTP server (localhost:19223) running in the Electron main process.
 *
 * Usage:
 *   pi-browser navigate <url>
 *   pi-browser snapshot
 *   pi-browser click <selector>
 *   pi-browser fill <selector> <value>
 *   pi-browser screenshot [--output <path>]
 *   pi-browser scroll <up|down> [amount]
 *   pi-browser evaluate <expression>
 *   pi-browser url
 *   pi-browser health
 */

const BASE_URL = 'http://127.0.0.1:19223';

// ── HTTP helper ──
async function request(method, path, body) {
  const url = `${BASE_URL}${path}`;
  const options = { method, headers: {} };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(url, options);
    const text = await res.text();
    if (!res.ok) {
      let errMsg;
      try { errMsg = JSON.parse(text).error; } catch { errMsg = text; }
      process.stderr.write(`Error: ${errMsg}\n`);
      process.exit(1);
    }
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.message?.includes('fetch failed')) {
      process.stderr.write('Error: Cannot connect to pi-browser server. Is the Pi Coding Agent desktop app running?\n');
      process.exit(1);
    }
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
}

// ── Output helpers ──
function outputJSON(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function outputText(text) {
  process.stdout.write(text + '\n');
}

// ── Main CLI ──
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    outputText(`pi-browser — Browser automation CLI for Pi Coding Agent

Usage:
  pi-browser navigate <url>              Navigate to a URL
  pi-browser snapshot                     Get interactive elements tree with ref IDs
  pi-browser click <selector>            Click an element (supports [N], :has-text, role=, text=, CSS)
  pi-browser fill <selector> <value>     Fill an input with a value
  pi-browser hover <selector>            Hover over an element
  pi-browser select <selector> <value>   Select an option in a <select> dropdown
  pi-browser type_and_select <selector> <text> <option>  Type text into input, then select matching autocomplete suggestion
  pi-browser press <key>                 Press a keyboard key (Enter, Tab, Escape, ArrowDown, etc.)
  pi-browser wait <selector> [timeout]   Wait for an element to appear (default 10s)
  pi-browser text [selector]             Get text content of element or entire page
  pi-browser attribute <selector> <attr> Get an attribute value of an element
  pi-browser screenshot [--output <path>] [--fullpage] [--analyze]  Take a screenshot (base64 or save to file)
  pi-browser scroll <up|down> [amount]   Scroll the page
  pi-browser evaluate <expression>       Evaluate JavaScript in the page
  pi-browser url                         Get current URL and title
  pi-browser health                      Check server health

Selectors (in priority order):
  [N]                     Use ref ID from snapshot (most reliable)
  text="Sign In"          Find element by text content
  button:has-text("Save") CSS tag + text match
  role=button[name="Save"] ARIA role-based
  [data-testid="x"]       data-testid attribute
  #id, .class, input[name=email]  Standard CSS`);
    return;
  }

  switch (command) {
    case 'navigate': {
      const url = args[1];
      if (!url) { outputText('Usage: pi-browser navigate <url>'); process.exit(1); }
      const result = await request('POST', '/navigate', { url });
      outputJSON(result);
      break;
    }

    case 'snapshot': {
      const result = await request('GET', '/snapshot');
      // Output the snapshot text directly (not wrapped in JSON) for readability
      outputText(result.snapshot || '(empty page)');
      break;
    }

    case 'click': {
      const selector = args[1];
      if (!selector) { outputText('Usage: pi-browser click <selector>'); process.exit(1); }
      const result = await request('POST', '/click', { selector });
      outputJSON(result);
      break;
    }

    case 'fill': {
      const selector = args[1];
      const value = args[2];
      if (!selector || value === undefined) {
        outputText('Usage: pi-browser fill <selector> <value>');
        process.exit(1);
      }
      const result = await request('POST', '/fill', { selector, value });
      outputJSON(result);
      break;
    }

    case 'hover': {
      const selector = args[1];
      if (!selector) { outputText('Usage: pi-browser hover <selector>'); process.exit(1); }
      const result = await request('POST', '/hover', { selector });
      outputJSON(result);
      break;
    }

    case 'select': {
      const selector = args[1];
      const value = args[2];
      if (!selector || value === undefined) {
        outputText('Usage: pi-browser select <selector> <value>');
        process.exit(1);
      }
      const result = await request('POST', '/select', { selector, value });
      outputJSON(result);
      break;
    }

    case 'type_and_select': {
      const selector = args[1];
      const text = args[2];
      const option = args[3];
      const wait = args[4] ? parseInt(args[4], 10) : undefined;
      if (!selector || !text || !option) {
        outputText('Usage: pi-browser type_and_select <selector> <text> <option> [wait_ms]');
        process.exit(1);
      }
      const result = await request('POST', '/type-and-select', { selector, text, option, wait });
      outputJSON(result);
      break;
    }

    case 'press': {
      const key = args[1];
      if (!key) { outputText('Usage: pi-browser press <key>'); process.exit(1); }
      const result = await request('POST', '/press', { key });
      outputJSON(result);
      break;
    }

    case 'wait': {
      const selector = args[1];
      if (!selector) { outputText('Usage: pi-browser wait <selector> [timeout]'); process.exit(1); }
      const timeout = args[2] ? parseInt(args[2], 10) : 10000;
      const result = await request('POST', '/wait', { selector, timeout });
      outputJSON(result);
      break;
    }

    case 'text': {
      const selector = args[1];
      if (selector) {
        const result = await request('POST', '/text', { selector });
        outputText(result.text || '');
      } else {
        const result = await request('GET', '/text');
        outputText(result.text || '');
      }
      break;
    }

    case 'attribute': {
      const selector = args[1];
      const attr = args[2];
      if (!selector || !attr) {
        outputText('Usage: pi-browser attribute <selector> <attribute>');
        process.exit(1);
      }
      const result = await request('POST', '/attribute', { selector, attribute: attr });
      outputJSON(result);
      break;
    }

    case 'screenshot': {
      const outputIdx = args.indexOf('--output');
      const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : null;
      const fullPage = args.includes('--fullpage') || args.includes('--full');
      const analyze = args.includes('--analyze') || args.includes('--describe');
      let queryParams = [];
      if (fullPage) queryParams.push('fullPage=true');
      if (analyze) queryParams.push('analyze=true');
      const query = queryParams.length > 0 ? '?' + queryParams.join('&') : '';
      const result = await request('GET', '/screenshot' + query);
      if (outputPath) {
        const fs = await import('fs');
        const base64Data = result.screenshot || result.base64;
        if (base64Data) {
          fs.writeFileSync(outputPath, Buffer.from(base64Data, 'base64'));
        }
        outputText(`Screenshot saved to ${outputPath}`);
        if (result.description) {
          outputText('\nDescription: ' + result.description);
        }
      } else {
        outputJSON(result);
      }
      break;
    }

    case 'scroll': {
      const direction = args[1] || 'down';
      const amount = args[2] ? parseInt(args[2], 10) : 500;
      if (!['up', 'down'].includes(direction)) {
        outputText('Usage: pi-browser scroll <up|down> [amount]');
        process.exit(1);
      }
      const result = await request('POST', '/scroll', { direction, amount });
      outputJSON(result);
      break;
    }

    case 'evaluate': {
      const expression = args.slice(1).join(' ');
      if (!expression) { outputText('Usage: pi-browser evaluate <expression>'); process.exit(1); }
      const result = await request('POST', '/evaluate', { expression });
      outputJSON(result);
      break;
    }

    case 'url': {
      const result = await request('GET', '/url');
      outputJSON(result);
      break;
    }

    case 'health': {
      const result = await request('GET', '/health');
      outputJSON(result);
      break;
    }

    default:
      outputText(`Unknown command: ${command}\nRun 'pi-browser --help' for usage.`);
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
