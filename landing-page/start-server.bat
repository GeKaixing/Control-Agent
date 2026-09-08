@echo off
echo 启动周末时光落地页服务器...
echo.

REM 检查Python是否可用
python --version >nul 2>&1
if errorlevel 1 (
    echo 错误: 未找到Python，请先安装Python
    echo 下载地址: https://www.python.org/downloads/
    pause
    exit /b 1
)

REM 启动服务器
echo 正在启动服务器...
python start-server.py

pause