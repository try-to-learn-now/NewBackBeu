// /api/get-range-results.js
import fetch from 'node-fetch'; // Or use built-in fetch if Node v18+

// --- Hardcoded parameters based on your example ---
const YEAR = '2024';
const SEMESTER = 'V';
const EXAM_HELD = 'July/2025'; // Will be URL encoded
const PREFIX_LENGTH = 8; // Define how long the actual prefix is (e.g., 22104134 has 8 digits)
// --- ---

// --- Function to fetch a single result (same as before) ---
async function fetchSingleResult(regNo) {
    const encodedExamHeld = encodeURIComponent(EXAM_HELD);
    const targetUrl = `https://beu-bih.ac.in/backend/v1/result/get-result?year=${YEAR}&redg_no=${regNo}&semester=${SEMESTER}&exam_held=${encodedExamHeld}`;

    try {
        const apiResponse = await fetch(targetUrl, {
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Referer': `https://beu-bih.ac.in/result-two/some-exam-name?semester=${SEMESTER}&session=${YEAR}&exam_held=${encodedExamHeld}`
            },
             signal: AbortSignal.timeout(8000) // 8 second timeout per request
        });

        if (!apiResponse.ok) {
            console.warn(`API fetch failed for ${regNo}: ${apiResponse.status} ${apiResponse.statusText}`);
            return { status: 'failed', regNo: regNo, reason: `HTTP ${apiResponse.status}` };
        }

        const jsonData = await apiResponse.json();

        if (jsonData.status !== 200 || !jsonData.data) {
            console.warn(`API returned non-success or no data for ${regNo}: ${jsonData.message}`);
            return { status: 'failed', regNo: regNo, reason: jsonData.message || `API Status ${jsonData.status}` };
        }

        return { status: 'success', regNo: regNo, data: jsonData.data };

    } catch (error) {
        console.error(`Error fetching ${regNo}:`, error.name === 'TimeoutError' ? 'Request Timed Out' : error.message);
        return { status: 'error', regNo: regNo, reason: error.name === 'TimeoutError' ? 'Request Timed Out' : 'Fetch Error' };
    }
}

// --- Main API Handler ---
export default async function handler(req, res) {
    // --- Get the FULL 11-digit registration number from the 'prefix' query param ---
    const fullRegNo = req.query.prefix; // Using 'prefix' as the parameter name as requested

    // --- Input Validation ---
    if (!fullRegNo || !/^\d{11}$/.test(fullRegNo)) { // Check if it's exactly 11 digits
        return res.status(400).json({
            error: 'Missing or invalid parameter. Please provide a full 11-digit registration number using the "prefix" query parameter.',
            example: '?prefix=22104134010'
        });
    }

    // --- Extract the actual prefix ---
    const actualPrefix = fullRegNo.substring(0, PREFIX_LENGTH); // Takes the first 8 digits

    // --- Generate the list of registration numbers based on the extracted prefix ---
    const registrationNumbers = [];
    // Range 1: 010 to 060
    for (let i = 10; i <= 60; i++) {
        const suffix = i.toString().padStart(3, '0');
        registrationNumbers.push(`${actualPrefix}${suffix}`);
    }
    // Range 2: 901 to 960
    for (let i = 901; i <= 960; i++) {
        registrationNumbers.push(`${actualPrefix}${i}`);
    }

    console.log(`Attempting to fetch results for ${registrationNumbers.length} numbers with extracted prefix ${actualPrefix}...`);

    try {
        // --- Fetch all results in parallel ---
        const results = await Promise.allSettled(
            registrationNumbers.map(regNo => fetchSingleResult(regNo))
        );

        // --- Filter out only the successful results ---
        const successfulResults = results
            .filter(result => result.status === 'fulfilled' && result.value.status === 'success')
            .map(result => result.value.data); // Extract only the 'data' part

        console.log(`Successfully fetched ${successfulResults.length} results out of ${registrationNumbers.length} for extracted prefix ${actualPrefix}.`);

        // --- Send Response ---
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800'); // Cache for 1 hour
        res.status(200).json({
            count: successfulResults.length,
            total_attempted: registrationNumbers.length,
            extracted_prefix: actualPrefix, // Show which prefix was used
            exam_details: { year: YEAR, semester: SEMESTER, held: EXAM_HELD },
            results: successfulResults // Array of result objects
        });

    } catch (error) {
        console.error(`General error processing range for extracted prefix ${actualPrefix}:`, error);
        res.status(500).json({
            error: 'An unexpected error occurred while processing the range.',
            details: error.message
        });
    }
}
