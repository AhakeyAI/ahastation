import type { ITheme } from '@xterm/xterm';

export type TerminalAppearance = 'light' | 'dark';
// Tango-based light palette, aligned with Orca's Builtin Tango Light.
// Source: Orca src/shared/terminal-themes/defaults.ts (MIT; see NOTICE below).
export const TERMINAL_THEMES: Record<TerminalAppearance, ITheme> = {
  light: {
    background: '#ffffff', foreground: '#2e3434', cursor: '#2e3434', cursorAccent: '#ffffff',
    selectionBackground: '#accef7', selectionForeground: '#2e3434',
    black: '#2e3436', red: '#b84a42', green: '#2f6f3f', yellow: '#8a6d1d',
    blue: '#3465a4', magenta: '#75507b', cyan: '#05727e', white: '#666666',
    brightBlack: '#585c62', brightRed: '#ca5b52', brightGreen: '#4a8054', brightYellow: '#a1842f',
    brightBlue: '#487ab5', brightMagenta: '#916b96', brightCyan: '#2b828a', brightWhite: '#3d3d3d',
  },
  dark: {
    background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4', cursorAccent: '#1e1e1e',
    selectionBackground: '#264f78', selectionForeground: '#f0f0f0',
    black: '#1e1e1e', red: '#d47c74', green: '#78a877', yellow: '#c5a86a',
    blue: '#7da2d0', magenta: '#ad8bb8', cyan: '#6ca8ad', white: '#c8c8c8',
    brightBlack: '#858b92', brightRed: '#df928a', brightGreen: '#91b98e', brightYellow: '#d2ba82',
    brightBlue: '#94b6dc', brightMagenta: '#bea2c7', brightCyan: '#88b9bd', brightWhite: '#eeeeee',
  },
};

/* NOTICE: MIT License — Copyright (c) 2026 Lovecast Inc.
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE. */
