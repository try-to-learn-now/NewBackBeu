// /api/result.js
import fetch from 'node-fetch';

// --- Configuration ---
const YEAR = '2024'; // Exam Year
const SEMESTER = 'V'; // Semester Code
const EXAM_HELD = 'July/2025'; // Exam Held Month/Year
const PREFIX_LENGTH = 8; // Length of the registration number prefix (e.g., 22104134)
const FETCH_TIMEOUT = 8000; // Timeout for each API request in milliseconds (8 seconds)
// --- ---

// --- Helper: Fetch Single Result ---
async function fetchSingleResult(regNo) {
    const encodedExamHeld = encodeURIComponent(EXAM_HELD);
    const targetUrl = `https://beu-bih.ac.in/backend/v1/result/get-result?year=${YEAR}&redg_no=${regNo}&semester=${SEMESTER}&exam_held=${encodedExamHeld}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
        const apiResponse = await fetch(targetUrl, {
            signal: controller.signal, // Use AbortController for timeout
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Referer': `https://beu-bih.ac.in/result-two/B.Tech.%205th%20Semester%20Examination%2C%202024?semester=${SEMESTER}&session=${YEAR}&exam_held=${encodedExamHeld}`
            }
        });

        clearTimeout(timeoutId); // Clear timeout if fetch completes

        if (!apiResponse.ok) {
            console.warn(`[${regNo}] API fetch failed: ${apiResponse.status} ${apiResponse.statusText}`);
            return { status: 'failed', regNo, reason: `HTTP ${apiResponse.status}` };
        }

        const jsonData = await apiResponse.json();

        if (jsonData.status !== 200 || !jsonData.data) {
            console.warn(`[${regNo}] API returned no data: ${jsonData.message || `Status ${jsonData.status}`}`);
            return { status: 'failed', regNo, reason: jsonData.message || `API Status ${jsonData.status}` };
        }

        return { status: 'success', regNo, data: jsonData.data };

    } catch (error) {
        clearTimeout(timeoutId); // Clear timeout if fetch fails
        if (error.name === 'AbortError') {
             console.error(`[${regNo}] Error: Request Timed Out after ${FETCH_TIMEOUT}ms`);
            return { status: 'error', regNo, reason: 'Request Timed Out' };
        } else {
            console.error(`[${regNo}] Error fetching: ${error.message}`);
            return { status: 'error', regNo, reason: 'Fetch Error' };
        }
    }
}

// --- Main Vercel API Handler ---
export default async function handler(req, res) {
    const fullRegNo = req.query.prefix; // Parameter name requested by user

    if (!fullRegNo || !/^\d{11}$/.test(fullRegNo)) {
        return res.status(400).json({
            error: 'Invalid parameter. Use "prefix" query parameter with a full 11-digit registration number.',
            example: '?prefix=22104134010'
        });
    }

    const actualPrefix = fullRegNo.substring(0, PREFIX_LENGTH);
    const registrationNumbers = [];

    // Generate numbers 010 to 060
    for (let i = 10; i <= 60; i++) {
        registrationNumbers.push(`${actualPrefix}${i.toString().padStart(3, '0')}`);
    }
    // Generate numbers 901 to 960
    for (let i = 901; i <= 960; i++) {
        registrationNumbers.push(`${actualPrefix}${i}`);
    }

    console.log(`[Handler] Attempting fetch for ${registrationNumbers.length} reg numbers with prefix ${actualPrefix}.`);

    try {
        const results = await Promise.allSettled(
            registrationNumbers.map(regNo => fetchSingleResult(regNo))
        );

        const successfulResults = results
            .filter(result => result.status === 'fulfilled' && result.value.status === 'success')
            .map(result => result.value.data);

        const failedCount = results.length - successfulResults.length;

        console.log(`[Handler] Fetched ${successfulResults.length} results successfully, ${failedCount} failed/not found.`);

        // Set cache header for Vercel Edge Network
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800'); // Cache 1 hour, stale 30 mins

        res.status(200).json({
            count_success: successfulResults.length,
            count_failed_or_missing: failedCount,
            total_attempted: registrationNumbers.length,
            extracted_prefix: actualPrefix,
            exam_details: { year: YEAR, semester: SEMESTER, held: EXAM_HELD },
            results: successfulResults // Array of result objects (only successful ones)
        });

    } catch (error) {
        // Catch unexpected errors in the main handler logic (less likely with Promise.allSettled)
        console.error(`[Handler] Unexpected error for prefix ${actualPrefix}:`, error);
        res.status(500).json({
            error: 'An unexpected server error occurred.',
            details: error.message
        });
    }
}
