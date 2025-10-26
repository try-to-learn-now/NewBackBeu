// /api/result.js
import fetch from 'node-fetch';

// --- Configuration ---
const RESULT_API_BASE_URL = 'https://beu-bih.ac.in/backend/v1/result/get-result';
const FETCH_TIMEOUT = 8000; // Timeout per individual result fetch (ms)
const BATCH_SIZE = 5;       // Fixed batch size
// --- ---

// --- Helper: Fetch Single Result using NEW API (Returns status object) ---
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

        if (!apiResponse.ok) { // Includes 5xx errors from BEU
            console.warn(`[${regNo}] BEU API fetch failed: ${apiResponse.status} ${apiResponse.statusText}`);
            // Treat non-404 HTTP errors as temporary server issues
            return { status: 'error', regNo, reason: `BEU API Error: HTTP ${apiResponse.status}` };
        }

        const jsonData = await apiResponse.json();

        // Specific check for BEU's 404 status
        if (jsonData.status === 404) {
             console.log(`[${regNo}] BEU API returned 404: Record not found.`);
             return { status: 'not_found', regNo, reason: jsonData.message || 'Record not found.' };
        }
        // Check for other non-success statuses from BEU API payload
        if (jsonData.status !== 200 || !jsonData.data) {
            console.warn(`[${regNo}] BEU API returned non-success or no data: ${jsonData.message || `Status ${jsonData.status}`}`);
            return { status: 'error', regNo, reason: `BEU API Data Error: ${jsonData.message || `Status ${jsonData.status}`}` };
        }

        // Success - return the data
        return { status: 'success', regNo, data: jsonData.data };

    } catch (error) {
        clearTimeout(timeoutId);
        const reason = error.name === 'AbortError' ? 'Request Timed Out' : `Fetch Error: ${error.message}`;
        console.error(`[${regNo}] Error fetching from BEU API: ${reason}`);
        // Treat timeouts and network errors as temporary issues
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

    // --- Input Parameters & Validation (Same as before) ---
    const { reg_no, year, semester, exam_held } = req.query;
    let validationError = null;
    if (!reg_no || !/^\d{11}$/.test(reg_no)) { validationError = 'Invalid parameter. Use "reg_no" query parameter with a full 11-digit registration number.'; }
    else if (!year || isNaN(parseInt(year))) { validationError = 'Missing or invalid "year" parameter.'; }
    const normalizedSemester = semester?.toUpperCase();
    const romanMap = { 'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5, 'VI': 6, 'VII': 7, 'VIII': 8 };
    if (!normalizedSemester || !romanMap[normalizedSemester]) { validationError = 'Missing or invalid "semester" parameter (use Roman numerals I-VIII).'; }
    else if (!exam_held) { validationError = 'Missing required "exam_held" parameter.'; }
    if (validationError) { return res.status(400).json({ error: validationError }); }

    const prefix = reg_no.slice(0, -3);
    const startNum = parseInt(reg_no.slice(-3), 10);
    if (isNaN(startNum)) { return res.status(400).json({ error: 'Could not parse starting number from reg_no.' }); }

    const encodedExamHeld = encodeURIComponent(exam_held);
    const registrationNumbers = [];
    const endNum = startNum + BATCH_SIZE - 1;
    for (let i = startNum; i <= endNum; i++) {
        const suffix = (i >= 900) ? i.toString() : i.toString().padStart(3, '0');
        registrationNumbers.push(`${prefix}${suffix}`);
    }
    console.log(`[Handler] Batch Fetch Start: Prefix ${prefix}, Sem ${normalizedSemester}, Year ${year}, Held ${exam_held}, Range ${startNum}-${endNum}`);

    try {
        // --- Fetch Batch Results in Parallel ---
        const fetchPromises = registrationNumbers.map(currentRegNo =>
            fetchSingleResult(currentRegNo, year, normalizedSemester, encodedExamHeld)
        );
        const results = await Promise.allSettled(fetchPromises);

        // --- Process and Map Results to Include Status --- // MODIFIED HERE
        const batchResponse = results.map((result, index) => {
            const attemptedRegNo = registrationNumbers[index]; // Get corresponding reg number

            if (result.status === 'fulfilled') {
                const fetchResult = result.value; // Result from fetchSingleResult
                switch (fetchResult.status) {
                    case 'success':
                        // Remove parent names before returning
                        delete fetchResult.data.father_name;
                        delete fetchResult.data.mother_name;
                        return { // Return successful data structure
                            regNo: fetchResult.regNo,
                            status: 'success',
                            data: fetchResult.data
                        };
                    case 'not_found':
                        return { // Return structure for "Not Found"
                            regNo: fetchResult.regNo,
                            status: 'Record not found' // Clear message
                        };
                    case 'failed':
                    case 'error':
                    default:
                        // Treat all other fetchSingleResult failures/errors as temporary
                        return { // Return structure for temporary errors
                            regNo: fetchResult.regNo,
                            status: 'Error fetching result (temporary)',
                            reason: fetchResult.reason // Include specific reason if available
                        };
                }
            } else {
                // Promise itself was rejected (should be rare with fetchSingleResult's try/catch)
                console.error(`[Handler] Promise rejected for ${attemptedRegNo}: ${result.reason}`);
                return { // Return structure for unexpected errors
                    regNo: attemptedRegNo,
                    status: 'Error fetching result (temporary)',
                    reason: 'Promise rejected during fetch'
                };
            }
        });

        console.log(`[Handler] Batch processed. Results mapped with status.`);

        // --- Send Response (No Vercel Cache Header) ---
        // Return the array containing status/data for each attempted reg number
        res.status(200).json(batchResponse);

    } catch (error) {
        console.error(`[Handler] Critical error processing batch request:`, error);
        res.status(500).json({
            error: 'An unexpected server error occurred processing the batch.',
            details: error.message
        });
    }
}
