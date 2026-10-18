import jwt from "jsonwebtoken";
import httpStatus from "http-status";
import { User } from "../models/user.model.js";
import { getJwtSecret } from "../config/jwt.js";

export const protect = async (req, res, next) => {
    let token = null;

    // Check Authorization header for Bearer token
    if (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
        token = req.headers.authorization.split(" ")[1];
    } else if (req.query && req.query.token) {
        // Fallback for query param (backward compatibility)
        token = req.query.token;
    } else if (req.body && req.body.token) {
        // Fallback for body param (backward compatibility)
        token = req.body.token;
    }

    if (!token) {
        return res.status(httpStatus.UNAUTHORIZED).json({
            success: false,
            message: "Authentication required. Please provide a valid token."
        });
    }

    try {
        const decoded = jwt.verify(token, getJwtSecret());

        const user = await User.findById(decoded.id).select("-password");
        if (!user) {
            return res.status(httpStatus.UNAUTHORIZED).json({
                success: false,
                message: "User account no longer exists."
            });
        }

        req.user = user;
        next();
    } catch (err) {
        if (err.name === "TokenExpiredError") {
            return res.status(httpStatus.UNAUTHORIZED).json({
                success: false,
                message: "Session expired. Please log in again."
            });
        }
        return res.status(httpStatus.UNAUTHORIZED).json({
            success: false,
            message: "Invalid authentication token."
        });
    }
};

