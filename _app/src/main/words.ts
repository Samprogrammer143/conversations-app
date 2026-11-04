// The computer's own word in the app's messages: "this Mac" on a Mac, "this PC" on Windows.
// (Other computers stay "PCs": "another PC", "all your PCs".)
export const PC = process.platform === "darwin" ? "Mac" : "PC";
