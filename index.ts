
import express from "express";

const app=express();


app.use(express.json());


app.get("/",(req,res)=>{
    res.send("Hello via Bun!");
});

app.post("/webhook",(req,res)=>{

    console.log('body', req.body);
    res.send("Webhook received!");
});
app.listen(3000,()=>{
    console.log("Server is running on port 3000");
});