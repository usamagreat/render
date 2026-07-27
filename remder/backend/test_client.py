import asyncio
import websockets

async def test():
    try:
        async with websockets.connect('ws://127.0.0.1:8000/ws/parent') as ws:
            print("Python connected successfully!")
            await ws.send('{"command": "TEST"}')
    except Exception as e:
        print(f"Failed to connect: {e}")

asyncio.run(test())
