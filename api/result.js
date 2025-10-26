// /api/result.js
import fetch from 'node-fetch';

// --- Configuration ---
const RESULT_API_BASE_URL = 'https://beu-bih.ac.in/backend/v1/result/get-result';
const FETCH_TIMEOUT = 8000; // Timeout per individual result fetch (ms)
const DEFAULT_BATCH_SIZE = 5;
const MAX_BATCH_SIZE = 10; // Safety limit
// --- ---

// --- Helper: Fetch Single Result using NEW API ---
async function fetchSingleResult(regNo, year, semesterRoman, encodedExamHeld) {
    const targetUrl = `${RESULT_API_BASE_URL}?year=${year}&redg_no=${regNo}&semester=${semesterRoman}&exam_held=${encodedExamHeld}`;
    // Use AbortController for reliable timeouts with node-fetch v3+
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
        const apiResponse = await fetch(targetUrl, {
            signal: controller.signal,
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                // Adding a Referer might be necessary if the API checks it
                'Referer': `https://beu-bih.ac.in/result-two/results?semester=${semesterRoman}&session=${year}&exam_held=${encodedExamHeld}`
            }
        });
        clearTimeout(timeoutId); // Clear the timeout timer if fetch completes

        // Handle non-OK HTTP responses (e.g., 500, 503 from BEU server)
        if (!apiResponse.ok) {
            console.warn(`[${regNo}] API fetch failed: ${apiResponse.status} ${apiResponse.statusText}`);
            return { status: 'failed', regNo, reason: `HTTP ${apiResponse.status}` };
        }

        // Parse the JSON response body
        const jsonData = await apiResponse.json();

        // Handle BEU API's specific "Not Found" status
        if (jsonData.status === 404) {
             console.log(`[${regNo}] API returned 404: Record not found.`);
             return { status: 'not_found', regNo, reason: jsonData.message || 'Record not found.' };
        }
        // Handle other non-success statuses within the JSON payload
        if (jsonData.status !== 200 || !jsonData.data) {
            console.warn(`[${regNo}] API returned non-success or no data: ${jsonData.message || `Status ${jsonData.status}`}`);
            return { status: 'failed', regNo, reason: jsonData.message || `API Status ${jsonData.status}` };
        }

        // Success case
        return { status: 'success', regNo, data: jsonData.data };

    } catch (error) {
        clearTimeout(timeoutId); // Clear timeout timer if fetch fails/aborts
        // Distinguish between timeout and other fetch errors
        const reason = error.name === 'AbortError' ? 'Request Timed Out' : `Fetch Error: ${error.message}`;
        console.error(`[${regNo}] Error fetching: ${reason}`);
        return { status: 'error', regNo, reason };
    }
}

// --- Main Vercel API Handler ---
export default async function handler(req, res) {
    // --- Set CORS Headers for all responses ---
    res.setHeader('Access-Control-Allow-Origin', '*'); // Allow any origin
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS'); // Allow GET and OPTIONS methods
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); // Allow Content-Type header

    // --- Handle CORS Preflight (OPTIONS method) ---
    // Browsers send an OPTIONS request first to check CORS permission
    if (req.method === 'OPTIONS') {
        return res.status(204).end(); // Respond with 204 No Content
    }

    // --- Proceed only for GET requests ---
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET', 'OPTIONS']);
        return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
    }

    // --- Input Parameters ---
    const { prefix, year, semester, exam_held, start_suffix, batch_size } = req.query;

    // --- Input Validation ---
    let validationError = null;
    if (!prefix || !/^\d{8}$/.test(prefix)) {
        validationError = 'Invalid parameter. Use "prefix" query parameter with an 8-digit registration prefix.';
    } else if (!year || isNaN(parseInt(year))) {
        validationError = 'Missing or invalid "year" parameter.';
    }
    const normalizedSemester = semester?.toUpperCase();
    const romanMap = { 'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6, 'VII': 7, 'VIII': 8 };
    if (!normalizedSemester || !romanMap[normalizedSemester]) {
        validationError = 'Missing or invalid "semester" parameter (use Roman numerals I-VIII).';
    } else if (!exam_held) {
        validationError = 'Missing required "exam_held" parameter.';
    }
    const startNum = parseInt(start_suffix);
    if (isNaN(startNum) || startNum < 1) {
        validationError = 'Missing or invalid "start_suffix" parameter (must be a positive number).';
    }
    let finalSize = parseInt(batch_size) || DEFAULT_BATCH_SIZE; // Use default if not provided or NaN
    if (isNaN(finalSize) || finalSize < 1 || finalSize > MAX_BATCH_SIZE) {
        console.warn(`Invalid or large batch_size requested (${batch_size}), capping at ${MAX_BATCH_SIZE}`);
        finalSize = Math.min(Math.max(finalSize, 1), MAX_BATCH_SIZE); // Cap between 1 and MAX_BATCH_SIZE
    }

    if (validationError) {
        return res.status(400).json({ error: validationError });
    }

    // --- Prepare parameters ---
    const encodedExamHeld = encodeURIComponent(exam_held);

    // --- Generate Registration Numbers for the specific batch ---
    const registrationNumbers = [];
    const endNum = startNum + finalSize - 1;
    for (let i = startNum; i <= endNum; i++) {
        // Handle padding correctly for different ranges
        const suffix = (i >= 900) ? i.toString() : i.toString().padStart(3, '0');
        registrationNumbers.push(`${prefix}${suffix}`);
    }

    console.log(`[Handler] Batch Fetch Start: Prefix ${prefix}, Sem ${normalizedSemester}, Year ${year}, Held ${exam_held}, Range ${startNum}-${endNum} (Size ${finalSize})`);

    try {
        // --- Fetch Batch Results in Parallel ---
        const results = await Promise.allSettled(
            registrationNumbers.map(regNo => fetchSingleResult(regNo, year, normalizedSemester, encodedExamHeld))
        );

        // --- Process Results (Filter only successes) ---
        const successfulResultsData = [];
        let failedOrNotFoundCount = 0;
        results.forEach(result => {
             if (result.status === 'fulfilled' && result.value.status === 'success') {
                 successfulResultsData.push(result.value.data); // Collect only data from successful fetches
             } else {
                 failedOrNotFoundCount++; // Count failures, timeouts, and 'not_found'
                 // Log details of the failure/rejection
                 const reason = result.status === 'fulfilled' ? result.value.reason : result.reason;
                 const regNo = result.status === 'fulfilled' ? result.value.regNo : 'N/A';
                 console.log(`[Handler] Failed/Not Found for ${regNo}: ${reason}`);
             }
        });

        console.log(`[Handler] Batch completed. Success: ${successfulResultsData.length}, Failed/Not Found: ${failedOrNotFoundCount}`);

        // --- Send Response ---
        // NO Vercel Caching Header is set. Response includes only successful data.
        res.status(200).json(successfulResultsData);

    } catch (error) {
        // Catch unexpected errors in the main handler logic itself
        console.error(`[Handler] Critical error processing batch request:`, error);
        res.status(500).json({
            error: 'An unexpected server error occurred processing the batch.',
            details: error.message
        });
    }
}
