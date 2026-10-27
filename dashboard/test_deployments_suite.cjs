const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:3000';
const DEVICE_ID = 'b37a3eb0-8e39-4c5b-8c86-38d68a4bf379'; // NYXPC

async function runTests() {
  console.log('====================================================');
  console.log(' ScriptRunner Software Deployment Verification Suite');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  // ----------------------------------------------------
  // TEST 1: Invalid file format rejection
  // ----------------------------------------------------
  console.log('--- Test 1: Unsupported File Format Rejection ---');
  try {
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="sample_script.txt"',
      'Content-Type: text/plain',
      '',
      'This is plain text, not an installer.',
      `--${boundary}`,
      'Content-Disposition: form-data; name="device_ids"',
      '',
      `["${DEVICE_ID}"]`,
      `--${boundary}--`
    ].join('\r\n');

    const res = await fetch(`${BASE_URL}/api/deployments/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const json = await res.json();
    assert(res.status === 400 && json.error && json.error.toLowerCase().includes('unsupported'), `Rejects .txt with HTTP 400: "${json.error}"`);
  } catch (err) {
    assert(false, `Test 1 failed with error: ${err.message}`);
  }

  // ----------------------------------------------------
  // TEST 2: Missing file rejection
  // ----------------------------------------------------
  console.log('\n--- Test 2: Missing File Rejection ---');
  try {
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="device_ids"',
      '',
      `["${DEVICE_ID}"]`,
      `--${boundary}--`
    ].join('\r\n');

    const res = await fetch(`${BASE_URL}/api/deployments/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const json = await res.json();
    assert(res.status === 400 && json.error && json.error.includes('Please select an installer'), `Rejects empty submission with HTTP 400: "${json.error}"`);
  } catch (err) {
    assert(false, `Test 2 failed with error: ${err.message}`);
  }

  // ----------------------------------------------------
  // TEST 3: Unauthorized download token rejection
  // ----------------------------------------------------
  console.log('\n--- Test 3: Unauthorized Download Token Security ---');
  try {
    const res = await fetch(`${BASE_URL}/api/packages/download/some-fake-id?token=invalid_untrusted_token_12345`);
    assert(res.status === 403 || res.status === 404, `Rejects unauthorized package download with HTTP ${res.status}`);
  } catch (err) {
    assert(false, `Test 3 failed with error: ${err.message}`);
  }

  // ----------------------------------------------------
  // TEST 4: Offline device job persistence
  // ----------------------------------------------------
  console.log('\n--- Test 4: Offline Target Device Handling ---');
  let offlineJobId = null;
  try {
    const offlineDeviceId = '99999999-9999-9999-9999-999999999999';
    const testExePath = path.join(__dirname, 'test_assets', 'test-app-installer.exe');
    const exeBuffer = fs.readFileSync(testExePath);

    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
    const bodyBuffer = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="offline_test.exe"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      exeBuffer,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="device_ids"\r\n\r\n["${offlineDeviceId}"]\r\n--${boundary}--\r\n`)
    ]);

    const res = await fetch(`${BASE_URL}/api/deployments/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: bodyBuffer,
    });
    const json = await res.json();
    assert(res.status === 200 && json.jobs && json.jobs.length === 1, 'Creates deployment job targeting offline device');
    offlineJobId = json.jobs[0].id;
    assert(json.jobs[0].state === 'queued', `Job is held in queued state (state = "${json.jobs[0].state}")`);
  } catch (err) {
    assert(false, `Test 4 failed with error: ${err.message}`);
  }

  // ----------------------------------------------------
  // TEST 5 & 6: Job Cancellation and Retry
  // ----------------------------------------------------
  console.log('\n--- Test 5 & 6: Job Cancellation and Retry ---');
  if (offlineJobId) {
    try {
      // Cancel
      const cancelRes = await fetch(`${BASE_URL}/api/deployments/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', job_id: offlineJobId }),
      });
      const cancelJson = await cancelRes.json();
      assert(cancelJson.success === true, 'Successfully cancelled queued job');

      const statusRes = await fetch(`${BASE_URL}/api/deployments/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get', job_id: offlineJobId }),
      });
      const statusJson = await statusRes.json();
      assert(statusJson.job && statusJson.job.state === 'cancelled', 'Verified state changed to "cancelled"');

      // Retry
      const retryRes = await fetch(`${BASE_URL}/api/deployments/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry', job_id: offlineJobId }),
      });
      const retryJson = await retryRes.json();
      assert(retryJson.success === true, 'Successfully retried cancelled job');

      const recheckRes = await fetch(`${BASE_URL}/api/deployments/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get', job_id: offlineJobId }),
      });
      const recheckJson = await recheckRes.json();
      assert(recheckJson.job && recheckJson.job.state === 'queued', 'Verified state returned to "queued"');

      // Clean up test job
      await fetch(`${BASE_URL}/api/deployments/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', job_id: offlineJobId }),
      });
    } catch (err) {
      assert(false, `Cancel/retry failed: ${err.message}`);
    }
  }

  // ----------------------------------------------------
  // TEST 7: Failed Installer Execution Handling
  // ----------------------------------------------------
  console.log('\n--- Test 7: Failed Installer Execution Handling ---');
  try {
    const failExePath = path.join(__dirname, 'test_assets', 'test-fail-installer.exe');
    const exeBuffer = fs.readFileSync(failExePath);

    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
    const bodyBuffer = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test-fail-installer.exe"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      exeBuffer,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="device_ids"\r\n\r\n["${DEVICE_ID}"]\r\n--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nTest Failing App\r\n--${boundary}--\r\n`)
    ]);

    const res = await fetch(`${BASE_URL}/api/deployments/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: bodyBuffer,
    });
    const json = await res.json();
    assert(res.status === 200 && json.jobs && json.jobs.length > 0, 'Created deployment job for test-fail-installer.exe');

    const failJobId = json.jobs[0].id;
    console.log(`[INFO] Waiting for agent to claim and execute fail job (${failJobId})...`);

    let finalFailJob = null;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const statusRes = await fetch(`${BASE_URL}/api/deployments/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get', job_id: failJobId }),
      });
      const sJson = await statusRes.json();
      if (sJson.job && (sJson.job.state === 'failed' || sJson.job.state === 'succeeded')) {
        finalFailJob = sJson.job;
        break;
      }
    }

    assert(finalFailJob !== null, 'Agent claimed and reported execution result');
    if (finalFailJob) {
      assert(finalFailJob.state === 'failed', `Deployment correctly marked as failed (state = "${finalFailJob.state}")`);
      assert(finalFailJob.exit_code === 1603, `Exit code captured accurately (exit_code = ${finalFailJob.exit_code})`);
      assert(finalFailJob.error_summary && finalFailJob.error_summary.includes('1603'), `Error summary captured: "${finalFailJob.error_summary}"`);
    }
  } catch (err) {
    assert(false, `Test 7 failed: ${err.message}`);
  }

  // ----------------------------------------------------
  // TEST 8: Successful End-to-End Installation & Verification
  // ----------------------------------------------------
  console.log('\n--- Test 8: Successful End-to-End Installation & Verification ---');
  try {
    const successExePath = path.join(__dirname, 'test_assets', 'test-app-installer.exe');
    const exeBuffer = fs.readFileSync(successExePath);

    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
    const bodyBuffer = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test-app-installer.exe"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      exeBuffer,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="device_ids"\r\n\r\n["${DEVICE_ID}"]\r\n--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nTest Application\r\n--${boundary}\r\nContent-Disposition: form-data; name="detection_rule"\r\n\r\n{"type":"registry_value","path":"HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\TestApp","name":"DisplayName","value":"Test Application"}\r\n--${boundary}--\r\n`)
    ]);

    const res = await fetch(`${BASE_URL}/api/deployments/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: bodyBuffer,
    });
    const json = await res.json();
    assert(res.status === 200 && json.jobs && json.jobs.length > 0, 'Created deployment job for test-app-installer.exe');

    const successJobId = json.jobs[0].id;
    console.log(`[INFO] Waiting for agent to claim and execute success job (${successJobId})...`);

    let finalSuccessJob = null;
    let seenStates = new Set();
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const statusRes = await fetch(`${BASE_URL}/api/deployments/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get', job_id: successJobId }),
      });
      const sJson = await statusRes.json();
      if (sJson.job) {
        seenStates.add(sJson.job.state);
        if (sJson.job.state === 'succeeded' || sJson.job.state === 'failed') {
          finalSuccessJob = sJson.job;
          break;
        }
      }
    }

    assert(finalSuccessJob !== null, 'Agent completed deployment workflow');
    if (finalSuccessJob) {
      assert(finalSuccessJob.state === 'succeeded', `Deployment successfully marked as succeeded (state = "${finalSuccessJob.state}")`);
      assert(finalSuccessJob.exit_code === 0, `Exit code 0 captured (exit_code = ${finalSuccessJob.exit_code})`);
      assert(finalSuccessJob.output && finalSuccessJob.output.includes('[verification]'), `Post-installation verification evaluated and logged in output`);
      console.log(`[INFO] States observed during deployment: ${Array.from(seenStates).join(' -> ')}`);
    }
  } catch (err) {
    assert(false, `Test 8 failed: ${err.message}`);
  }

  // ----------------------------------------------------
  // TEST 9: Real MSI Upload & Auto-Metadata Extraction
  // ----------------------------------------------------
  console.log('\n--- Test 9: Real MSI Upload & Auto-Metadata Extraction ---');
  try {
    const sampleMsi = 'C:\\Users\\USER\\Downloads\\artcraft-launcher-0.3.2-windows-x64.msi';
    if (fs.existsSync(sampleMsi)) {
      const msiBuffer = fs.readFileSync(sampleMsi);
      const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
      const bodyBuffer = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="artcraft-launcher-0.3.2-windows-x64.msi"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        msiBuffer,
        Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="device_ids"\r\n\r\n["${DEVICE_ID}"]\r\n--${boundary}--\r\n`)
      ]);

      const res = await fetch(`${BASE_URL}/api/deployments/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: bodyBuffer,
      });
      const json = await res.json();
      assert(res.status === 200 && json.package, 'MSI uploaded and processed via /api/deployments/deploy');
      assert(json.package.packageFormat === 'msi', 'Format detected as "msi"');
      assert(json.package.installArgs === '/qn /norestart', `Default silent args applied: ${json.package.installArgs}`);
      assert(json.package.sha256 && json.package.sha256.length === 64, `SHA-256 computed: ${json.package.sha256.slice(0, 16)}...`);
      console.log(`[INFO] MSI Product Name: "${json.package.packageName}", Version: "${json.package.version}"`);
      console.log(`[INFO] Auto-generated Detection Rule:`, json.package.detectionRule);
    } else {
      console.log('[SKIP] Sample MSI not found, skipping specific file test.');
    }
  } catch (err) {
    assert(false, `Test 9 failed: ${err.message}`);
  }

  console.log('\n====================================================');
  console.log(` Test Results: ${passed} passed, ${failed} failed`);
  console.log('====================================================');
}

runTests().catch((e) => console.error('Fatal test error:', e));
