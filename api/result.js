// /api/result.js
import fetch from 'node-fetch';

// --- Configuration ---
const RESULT_API_BASE_URL = 'https://beu-bih.ac.in/backend/v1/result/get-result';
const FETCH_TIMEOUT = 8000; // Timeout per individual result fetch (ms)
const BATCH_SIZE = 5;       // Fixed batch size like your old code
// --- ---

// --- Helper: Fetch Single Result using NEW API (Same as before) ---
async function fetchSingleResult(regNo, year, semesterRoman, encodedExamHeld) {
    const targetUrl = `${RESULT_API_BASE_URL}?year=${year}&redg_no=${regNo}&semester=${semesterRoman}&exam_held=${encodedExamHeld}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
        const apiResponse = await fetch(targetUrl, {
            signal: controller.signal,
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Referer': `https://beu-bih.ac.in/result-two/some-exam?semester=${semesterRoman}&session=${year}&exam_held=${encodedExamHeld}`
            }
        });
        clearTimeout(timeoutId);

        if (!apiResponse.ok) {
            console.warn(`[${regNo}] API fetch failed: ${apiResponse.status} ${apiResponse.statusText}`);
            return { status: 'failed', regNo, reason: `HTTP ${apiResponse.status}` };
        }

        const jsonData = await apiResponse.json();

        if (jsonData.status === 404) {
             console.log(`[${regNo}] API returned 404: Record not found.`);
             return { status: 'not_found', regNo, reason: jsonData.message || 'Record not found.' };
        }
        if (jsonData.status !== 200 || !jsonData.data) {
            console.warn(`[${regNo}] API returned non-success or no data: ${jsonData.message || `Status ${jsonData.status}`}`);
            return { status: 'failed', regNo, reason: jsonData.message || `API Status ${jsonData.status}` };
        }

        return { status: 'success', regNo, data: jsonData.data };

    } catch (error) {
        clearTimeout(timeoutId);
        const reason = error.name === 'AbortError' ? 'Request Timed Out' : `Fetch Error: ${error.message}`;
        console.error(`[${regNo}] Error fetching: ${reason}`);
        return { status: 'error', regNo, reason };
    }
}

// --- Main Vercel API Handler ---
export default async function handler(req, res) {
    // --- Set CORS Headers ---
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET', 'OPTIONS']);
        return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
    }

    // --- Input Parameters ---
    // Expecting 11-digit reg_no now
    const { reg_no, year, semester, exam_held } = req.query;

    // --- Input Validation ---
    let validationError = null;
    if (!reg_no || !/^\d{11}$/.test(reg_no)) { // Check for 11 digits
        validationError = 'Invalid parameter. Use "reg_no" query parameter with a full 11-digit registration number.';
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

    if (validationError) {
        return res.status(400).json({ error: validationError });
    }

    // --- Extract Prefix and Starting Number (like old code) ---
    const prefix = reg_no.slice(0, -3); // Gets the first 8 digits
    const startNum = parseInt(reg_no.slice(-3), 10); // Gets the number from the last 3 digits
    if (isNaN(startNum)) {
         // Should not happen due to 11-digit check, but good practice
         return res.status(400).json({ error: 'Could not parse starting number from reg_no.' });
    }

    // --- Prepare parameters ---
    const encodedExamHeld = encodeURIComponent(exam_held);

    // --- Generate Registration Numbers for the specific batch of 5 ---
    const registrationNumbers = [];
    const endNum = startNum + BATCH_SIZE - 1; // Calculate end number based on fixed batch size
    for (let i = startNum; i <= endNum; i++) {
        // Handle padding based on suffix range (though startNum likely implies range)
        const suffix = (i >= 900) ? i.toString() : i.toString().padStart(3, '0');
        registrationNumbers.push(`${prefix}${suffix}`);
    }

    console.log(`[Handler] Batch Fetch: Prefix ${prefix}, Sem ${normalizedSemester}, Year ${year}, Held ${exam_held}, Range ${startNum}-${endNum}`);

    try {
        // --- Fetch Batch Results in Parallel ---
        const results = await Promise.allSettled(
            registrationNumbers.map(currentRegNo => fetchSingleResult(currentRegNo, year, normalizedSemester, encodedExamHeld))
        );

        // --- Process Results (Filter only successes) ---
        const successfulResultsData = [];
        let failedOrNotFoundCount = 0;
        results.forEach(result => {
             if (result.status === 'fulfilled' && result.value.status === 'success') {
                 successfulResultsData.push(result.value.data);
             } else {
                 failedOrNotFoundCount++;
                 const reason = result.status === 'fulfilled' ? result.value.reason : result.reason;
                 const failedRegNo = result.status === 'fulfilled' ? result.value.regNo : 'N/A';
                 console.log(`[Handler] Failed/Not Found for ${failedRegNo}: ${reason}`);
             }
        });

        console.log(`[Handler] Batch completed. Success: ${successfulResultsData.length}, Failed/Not Found: ${failedOrNotFoundCount}`);

        // --- Send Response ---
        // NO Vercel Caching Header
        res.status(200).json(successfulResultsData); // Return array of successful results

    } catch (error) {
        // Catch unexpected errors in the main handler logic
        console.error(`[Handler] Critical error processing batch request:`, error);
        res.status(500).json({
            error: 'An unexpected server error occurred processing the batch.',
            details: error.message
        });
    }
}
