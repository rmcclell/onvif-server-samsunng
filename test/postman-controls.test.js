'use strict';

const vm = require('vm');
const xml2js = require('xml2js');
const collection = require('../contrib/postman/direct-camera-controls.postman_collection.json');

const requests = collection.item.flatMap(folder => folder.item);
const writes = collection.item[1].item;

function runGuard(event, values, url = 'http://192.168.1.129/onvif/device_service', raw = '') {
    const variables = new Map(Object.entries(values));
    const pm = {
        variables: {
            get: key => variables.get(key),
            set: (key, value) => variables.set(key, value),
            replaceIn: value => value.replace(/\{\{([^}]+)\}\}/g, (match, key) =>
                variables.has(key) ? variables.get(key) : match)
        },
        request: { url: { toString: () => url }, body: { raw } },
        execution: { skipRequest: jest.fn() }
    };
    let error;
    try {
        vm.runInNewContext(event.script.exec.join('\n'), { pm });
    } catch (err) {
        error = err;
    }
    return { pm, variables, error };
}

describe('Direct-camera Postman collection', () => {
    it('uses empty credentials and disabled write defaults', () => {
        const values = Object.fromEntries(collection.variable.map(v => [v.key, v.value]));
        expect(values.username).toBe('');
        expect(values.password).toBe('');
        expect(values.confirm_delete_timestamp).toBe('false');
        expect(values.confirm_auto_ir_cut).toBe('false');
        expect(collection.auth.type).toBe('digest');
    });

    it.each(requests.map(item => [item.name, item.request]))('has valid SOAP XML for %s', async (_name, request) => {
        expect(request.method).toBe('POST');
        const parser = new xml2js.Parser({ explicitArray: false });
        const xml = await parser.parseStringPromise(request.body.raw);
        expect(xml['s:Envelope'].$['xmlns:s']).toBe('http://www.w3.org/2003/05/soap-envelope');
        const body = xml['s:Envelope']['s:Body'];
        const operation = Object.keys(body)[0].split(':')[1];
        const contentType = request.header.find(header => header.key === 'Content-Type').value;
        expect(contentType).toContain('application/soap+xml');
        expect(contentType).toContain(`/${operation}"`);
        expect(request.url).toMatch(/^\{\{(device|media|imaging)_url\}\}$/);
    });

    it.each([
        [{}, 'http://192.168.1.129/onvif/device_service', ''],
        [{ camera_host: '192.168.1.189' }, 'http://192.168.1.189:8081/onvif/device_service', ''],
        [{ camera_host: '192.168.1.129' }, 'http://192.168.1.130/onvif/device_service', ''],
        [{ camera_host: '192.168.1.129' }, '{{device_url}}', ''],
        [{ camera_host: '192.168.1.129' }, 'http://192.168.1.129/onvif/device_service', '{{missing_token}}']
    ])('skips unconfigured or wrong destinations %#', (values, url, body) => {
        const result = runGuard(collection.event[0], values, url, body);
        expect(result.pm.execution.skipRequest).toHaveBeenCalled();
        expect(result.error).toBeDefined();
    });

    it('allows a resolved direct-camera read', () => {
        const result = runGuard(collection.event[0], { camera_host: '192.168.1.129' });
        expect(result.pm.execution.skipRequest).not.toHaveBeenCalled();
        expect(result.error).toBeUndefined();
    });

    it.each(writes.map((item, index) => [item.name, item, index]))('guards %s', (_name, item, index) => {
        const flag = index === 0 ? 'confirm_delete_timestamp' : 'confirm_auto_ir_cut';
        const token = index === 0 ? 'timestamp_osd_token' : 'video_source_token';
        const event = item.event[0];
        for (const values of [{}, { [flag]: 'true' }, { [flag]: 'true', [token]: '<unsafe>' }]) {
            expect(runGuard(event, values).pm.execution.skipRequest).toHaveBeenCalled();
        }
        const result = runGuard(event, { [flag]: 'true', [token]: 'camera-token' });
        expect(result.error).toBeUndefined();
        expect(result.pm.execution.skipRequest).not.toHaveBeenCalled();
        expect(result.variables.get(flag)).toBe('false');
        expect(runGuard(event, Object.fromEntries(result.variables)).pm.execution.skipRequest).toHaveBeenCalled();
    });
});
