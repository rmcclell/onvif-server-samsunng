'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

it('reports missing npm packages before starting the server', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onvif-deps-'));
    try {
        fs.copyFileSync(path.join(__dirname, '..', 'main.js'), path.join(dir, 'main.js'));
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
            dependencies: { 'onvif-missing-test-package': '1.0.0' }
        }));
        const result = spawnSync(process.execPath, [path.join(dir, 'main.js'), '--version'], {
            encoding: 'utf8'
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Required npm package "onvif-missing-test-package" is missing');
        expect(result.stderr).toContain('npm ci');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
