// No-op OpenGL stub (non-macOS hosts) so the upstream solver sources compile headless (their draw() methods are
// never called by the oracle).
#pragma once
#define GL_POINTS 0
#define GL_LINES 1
#define GL_LINE_LOOP 2
#define GL_QUADS 3
inline void glBegin(int) {}
inline void glEnd() {}
inline void glColor3f(float, float, float) {}
inline void glVertex2f(float, float) {}
