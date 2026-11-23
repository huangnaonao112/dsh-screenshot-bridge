@echo off
call "C:\Program Files\Microsoft Visual Studio\18\Professional\VC\Auxiliary\Build\vcvars64.bat" >nul
cl /nologo /std:c++17 /EHsc /O2 /MT /W4 /wd4100 /DUNICODE /D_UNICODE /FoC:\Users\huangnaonao112\Documents\deepseek-harness\default-workspace\dsh-screenshot-bridge\capture\wda\obj\ /c "C:\Users\huangnaonao112\Documents\deepseek-harness\default-workspace\dsh-screenshot-bridge\capture\wda\wdapay.cpp"
cl /nologo /std:c++17 /EHsc /O2 /MT /W4 /wd4100 /DUNICODE /D_UNICODE /FoC:\Users\huangnaonao112\Documents\deepseek-harness\default-workspace\dsh-screenshot-bridge\capture\wda\obj\ /c "C:\Users\huangnaonao112\Documents\deepseek-harness\default-workspace\dsh-screenshot-bridge\capture\wda\wdaclear.cpp"
link /nologo /DLL /SUBSYSTEM:WINDOWS /OUT:"C:\Users\huangnaonao112\Documents\deepseek-harness\default-workspace\dsh-screenshot-bridge\capture\wda\bin\wdapay-20261123062947.dll" "C:\Users\huangnaonao112\Documents\deepseek-harness\default-workspace\dsh-screenshot-bridge\capture\wda\obj\wdapay.obj" kernel32.lib user32.lib
link /nologo /SUBSYSTEM:CONSOLE /OUT:"C:\Users\huangnaonao112\Documents\deepseek-harness\default-workspace\dsh-screenshot-bridge\capture\wda\bin\wdaclear.exe" "C:\Users\huangnaonao112\Documents\deepseek-harness\default-workspace\dsh-screenshot-bridge\capture\wda\obj\wdaclear.obj" kernel32.lib user32.lib
exit /b 0
