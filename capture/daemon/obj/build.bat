@echo off
call "C:\Program Files\Microsoft Visual Studio\18\Professional\VC\Auxiliary\Build\vcvars64.bat" >nul
cl /nologo /std:c++17 /EHsc /O2 /MT /W4 /wd4100 /wd4244 /wd4459 /DUNICODE /D_UNICODE /FoC:\Users\huangnaonao112\Documents\deepseek-harness\default-workspace\dsh-screenshot-bridge\capture\daemon\obj\ /Fe:"C:\Users\huangnaonao112\Documents\deepseek-harness\default-workspace\dsh-screenshot-bridge\capture\daemon\bin\dshshotd.exe" "C:\Users\huangnaonao112\Documents\deepseek-harness\default-workspace\dsh-screenshot-bridge\capture\daemon\dshshotd.cpp" /link /SUBSYSTEM:CONSOLE d3d11.lib dxgi.lib windowscodecs.lib ole32.lib user32.lib gdi32.lib dwmapi.lib
exit /b 0
