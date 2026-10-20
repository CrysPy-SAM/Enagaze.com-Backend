import httpStatus from "http-status";
import mongoose from "mongoose";
import { getIceServersConfig } from "../config/webrtc.js";
import { Match } from "../models/match.model.js";
import { Block } from "../models/block.model.js";

// Bounded in-memory ring buffer for recent call diagnostics (max 100 entries)
const MAX_DIAGNOSTICS_RECORDS = 100;
const diagnosticRecords = [];

// Regular expressions to detect and redact sensitive personal data or raw network strings
const SENSITIVE_PATTERNS = [
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/, // IPv4 address
    /\b[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){7}\b/, // IPv6 address
    /(?:candidate:|v=0|m=video|m=audio|a=rtpmap|a=ice-)/i, // Raw SDP / candidate strings
    /bearer\s+[a-zA-Z0-9._-]+/i, // Bearer token
];

/**
 * Validates that a string does not contain IP addresses, SDP fragments, or credentials.
 * 
 * @param {any} val
 * @returns {boolean} True if safe, False if sensitive content detected
 */
function isSafeDiagnosticString(val) {
    if (typeof val !== "string") return true;
    for (const pattern of SENSITIVE_PATTERNS) {
        if (pattern.test(val)) return false;
    }
    return true;
}

/**
 * Sanitizes an incoming client diagnostic report against a strict low-cardinality whitelist.
 * 
 * Allowed fields:
 * - callId: string (format /^call_[0-9a-fA-F-]+$/)
 * - outcome: string (enum: 'connected' | 'failed' | 'ended' | 'declined' | 'timeout' | 'idle')
 * - queueWaitMs: number (>= 0)
 * - timeToConnectedMs: number (>= 0) or null
 * - callDurationSecs: number (>= 0)
 * - terminalConnectionState: string
 * - terminalIceConnectionState: string
 * - failureCategory: string or null
 * - selectedCandidatePair: object with only { localCandidateType, remoteCandidateType, protocol }
 * - iceRestartAttempts: number (>= 0)
 * 
 * @param {Object} raw
 * @returns {Object|null} Sanitized report or null if invalid
 */
export function sanitizeClientDiagnosticReport(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

    const callId = typeof raw.callId === "string" && /^call_[0-9a-fA-F-]+$/.test(raw.callId)
        ? raw.callId
        : undefined;

    const outcome = typeof raw.outcome === "string" && isSafeDiagnosticString(raw.outcome)
        ? raw.outcome.slice(0, 32)
        : "unknown";

    const queueWaitMs = Number.isFinite(raw.queueWaitMs) && raw.queueWaitMs >= 0
        ? Math.round(raw.queueWaitMs)
        : null;

    const timeToConnectedMs = Number.isFinite(raw.timeToConnectedMs) && raw.timeToConnectedMs >= 0
        ? Math.round(raw.timeToConnectedMs)
        : null;

    const callDurationSecs = Number.isFinite(raw.callDurationSecs) && raw.callDurationSecs >= 0
        ? Math.round(raw.callDurationSecs)
        : 0;

    const terminalConnectionState = typeof raw.terminalConnectionState === "string" && isSafeDiagnosticString(raw.terminalConnectionState)
        ? raw.terminalConnectionState.slice(0, 32)
        : null;

    const terminalIceConnectionState = typeof raw.terminalIceConnectionState === "string" && isSafeDiagnosticString(raw.terminalIceConnectionState)
        ? raw.terminalIceConnectionState.slice(0, 32)
        : null;

    const failureCategory = typeof raw.failureCategory === "string" && isSafeDiagnosticString(raw.failureCategory)
        ? raw.failureCategory.slice(0, 64)
        : null;

    let selectedCandidatePair = null;
    if (raw.selectedCandidatePair && typeof raw.selectedCandidatePair === "object") {
        const local = typeof raw.selectedCandidatePair.localCandidateType === "string" && isSafeDiagnosticString(raw.selectedCandidatePair.localCandidateType)
            ? raw.selectedCandidatePair.localCandidateType.slice(0, 16)
            : "unknown";
        const remote = typeof raw.selectedCandidatePair.remoteCandidateType === "string" && isSafeDiagnosticString(raw.selectedCandidatePair.remoteCandidateType)
            ? raw.selectedCandidatePair.remoteCandidateType.slice(0, 16)
            : "unknown";
        const protocol = typeof raw.selectedCandidatePair.protocol === "string" && isSafeDiagnosticString(raw.selectedCandidatePair.protocol)
            ? raw.selectedCandidatePair.protocol.slice(0, 8)
            : "unknown";

        selectedCandidatePair = {
            localCandidateType: local,
            remoteCandidateType: remote,
            protocol,
        };
    }

    const iceRestartAttempts = Number.isInteger(raw.iceRestartAttempts) && raw.iceRestartAttempts >= 0
        ? raw.iceRestartAttempts
        : 0;

    return {
        callId,
        outcome,
        queueWaitMs,
        timeToConnectedMs,
        callDurationSecs,
        terminalConnectionState,
        terminalIceConnectionState,
        failureCategory,
        selectedCandidatePair,
        iceRestartAttempts,
        receivedAt: new Date().toISOString(),
    };
}

/**
 * GET /api/v1/webrtc/ice-servers
 * Delivers secure STUN and TURN server configuration for the authenticated user.
 */
export const getIceServers = async (req, res) => {
    try {
        const userId = req.user?._id ? req.user._id.toString() : undefined;
        const config = getIceServersConfig(userId);

        return res.status(httpStatus.OK).json({
            success: true,
            iceServers: config.iceServers,
            iceTransportPolicy: config.iceTransportPolicy,
            hasTurn: config.hasTurn,
        });
    } catch (err) {
        console.error("[WebRTC Controller] getIceServers error:", err.message);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to retrieve WebRTC ICE server configuration.",
        });
    }
};

/**
 * POST /api/v1/webrtc/diagnostics
 * Ingests a client-side sanitized WebRTC connection diagnostics report.
 */
export const submitDiagnostics = async (req, res) => {
    try {
        const sanitized = sanitizeClientDiagnosticReport(req.body);
        if (!sanitized) {
            return res.status(httpStatus.BAD_REQUEST).json({
                success: false,
                message: "Invalid diagnostics payload format.",
            });
        }

        // Add to in-memory bounded ring buffer
        if (diagnosticRecords.length >= MAX_DIAGNOSTICS_RECORDS) {
            diagnosticRecords.shift();
        }
        diagnosticRecords.push(sanitized);

        return res.status(httpStatus.OK).json({
            success: true,
            recorded: true,
        });
    } catch (err) {
        console.error("[WebRTC Controller] submitDiagnostics error:", err.message);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to process diagnostics report.",
        });
    }
};

/**
 * Validates that authenticated user has an active connection with target user before calling.
 */
export const verifyCallAccess = async (req, res) => {
    const targetUserId = req.params.targetUserId || req.body.targetUserId;
    if (!targetUserId || !mongoose.Types.ObjectId.isValid(targetUserId)) {
        return res.status(httpStatus.BAD_REQUEST).json({
            success: false,
            message: "Invalid target user ID",
        });
    }

    try {
        const isBlocked = await Block.isBlockedBidirectional(req.user._id, targetUserId);
        if (isBlocked) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: "BLOCKED_USER",
                message: "Call not permitted.",
            });
        }

        const userPair = Match.getCanonicalPair(req.user._id, targetUserId);
        const activeMatch = await Match.findOne({ userPair, status: "active" });

        if (!activeMatch) {
            return res.status(httpStatus.FORBIDDEN).json({
                success: false,
                code: "CALL_UNAUTHORIZED",
                message: "Video calling is only allowed between users with an active connection.",
            });
        }

        return res.status(httpStatus.OK).json({
            success: true,
            allowed: true,
            matchId: activeMatch._id,
        });
    } catch (e) {
        console.error("verifyCallAccess error:", e);
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({
            success: false,
            message: "Failed to verify call access",
        });
    }
};

/**
 * Testing helper: retrieves current in-memory diagnostic records
 */
export const _testing = {
    getDiagnosticRecords: () => [...diagnosticRecords],
    clearDiagnosticRecords: () => {
        diagnosticRecords.length = 0;
    },
};

