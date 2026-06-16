// Re-export the shared DB client for module convenience.
// All modules should import from here instead of @/lib/db directly,
// so the import path is consistent across the modules/ structure.
export { db } from "@/lib/db"
